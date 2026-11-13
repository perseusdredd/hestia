#!/usr/bin/env node
/**
 * End-to-end smoke test against a RUNNING production server.
 *
 *   npm run build
 *   AUTH_URL=http://localhost:3210 CRON_SECRET=<16+ chars> npx next start -p 3210
 *   node scripts/smoke.mjs            # SMOKE_BASE_URL defaults to http://localhost:3210
 *
 * Everything goes over real HTTP: pages, route handlers, the Auth.js
 * credentials endpoint and server actions. Server actions are called the way
 * the browser calls them (POST + Next-Action header, React reply encoding);
 * action ids come from .next/server/server-reference-manifest.json, so the
 * script must run against the same build it reads.
 *
 * Creates a few users and two workspaces with random names. No cleanup: the
 * rows are tagged "smoke-" so `npm run smoke:cleanup` can delete them.
 * Plain Node >= 20, no dependencies. Mailed links (verify, reset) are read
 * from the EmailOutbox table through scripts/smoke-outbox.ts (tsx), so the
 * server must use the same DATABASE_URL. Start it with ENABLE_DEV_OUTBOX=true
 * to include the /dev/outbox checks (they are skipped when the page is off).
 * CRON_SECRET must be set on the server: /api/cron/cleanup is expected to
 * answer 401 to callers without it (503 means the cron is disabled).
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = (process.env.SMOKE_BASE_URL ?? "http://localhost:3210").replace(/\/$/, "");
const MANIFEST = resolve(process.cwd(), ".next/server/server-reference-manifest.json");

// ------------------------------------------------------------ reporting ----

const results = [];
function check(name, ok, detail = "") {
  detail = String(detail ?? "");
  if (detail.length > 160) detail = `${detail.slice(0, 157)}...`;
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return Boolean(ok);
}
function must(name, ok, detail) {
  if (!check(name, ok, detail)) throw new Error(`Fatal: ${name}`);
}

// --------------------------------------------------------------- client ----

class Client {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  store(res) {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => {
        const [k, v] = a.trim().split("=");
        if (k.toLowerCase() === "max-age") return Number(v) <= 0;
        if (k.toLowerCase() === "expires") return new Date(v).getTime() < Date.now();
        return false;
      });
      if (expired || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async fetch(path, init = {}) {
    const headers = new Headers(init.headers);
    if (this.cookies.size) headers.set("cookie", this.cookieHeader());
    const res = await fetch(path.startsWith("http") ? path : BASE + path, {
      ...init,
      headers,
      redirect: "manual",
    });
    this.store(res);
    return res;
  }

  async get(path) {
    const res = await this.fetch(path);
    const text = await res.text();
    return { res, status: res.status, text, location: res.headers.get("location") };
  }

  /** Call a server action like the React client does. `args` may contain one FormData. */
  async action(pagePath, actionKey, args) {
    const id = actionId(actionKey);
    const headers = {
      "Next-Action": id,
      Accept: "text/x-component",
      Origin: BASE,
    };
    let body;
    const formIndex = args.findIndex((a) => a instanceof FormData);
    if (formIndex === -1) {
      body = JSON.stringify(escapeArgs(args));
      headers["Content-Type"] = "text/plain;charset=UTF-8";
    } else {
      // React 19 encodeReply: the FormData becomes part 1 ("$K1"), its fields
      // are prefixed with "_1_", and the root array goes in field "0".
      body = new FormData();
      for (const [k, v] of args[formIndex].entries()) body.append(`_1_${k}`, v);
      const root = escapeArgs(args.map((a, i) => (i === formIndex ? null : a)));
      root[formIndex] = "$K1";
      body.append("0", JSON.stringify(root));
    }
    const res = await this.fetch(pagePath, { method: "POST", headers, body });
    const text = await res.text();
    if (process.env.SMOKE_DEBUG) {
      console.log(`[debug] ${actionKey} -> ${res.status}`, Object.fromEntries(res.headers), text.slice(0, 600));
    }
    return {
      status: res.status,
      redirect: res.headers.get("x-action-redirect") ?? res.headers.get("location"),
      result: parseActionResult(text),
      text,
    };
  }
}

/** React escapes strings that start with "$" as "$$". */
function escapeArgs(value) {
  if (typeof value === "string") return value.startsWith("$") ? `$${value}` : value;
  if (Array.isArray(value)) return value.map(escapeArgs);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, escapeArgs(v)]));
  }
  return value;
}

/** Pull the action's return value out of the RSC flight response. */
function parseActionResult(text) {
  const rows = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]+):(.*)$/.exec(line);
    if (!m) continue;
    try {
      rows.set(m[1], JSON.parse(m[2]));
    } catch {
      // non-JSON rows (hints, text chunks) are irrelevant here
    }
  }
  const root = rows.get("0");
  if (!root || typeof root !== "object") return undefined;
  const a = root.a;
  if (typeof a === "string" && a.startsWith("$@")) return rows.get(a.slice(2));
  return a;
}

let manifest;
function actionId(key) {
  manifest ??= JSON.parse(readFileSync(MANIFEST, "utf8"));
  const [file, name] = key.split("#");
  for (const [id, entry] of Object.entries(manifest.node ?? {})) {
    const workers = Object.values(entry.workers ?? {});
    const filename = entry.filename ?? workers[0]?.filename;
    const exportedName = entry.exportedName ?? workers[0]?.exportedName;
    if (filename === file && exportedName === name) return id;
  }
  throw new Error(`Server action not found in manifest: ${key}`);
}

/** Newest outbox rows for a smoke-* address, read from the DB via the tsx helper. */
function outbox(to, kind) {
  const cli = resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
  const out = execFileSync(process.execPath, [cli, "scripts/smoke-outbox.ts", to, ...(kind ? [kind] : [])], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out || "[]");
}

/** Origin and token of the first `<origin>/<route>/<token>` link in a mail's text. */
function linkToken(mail, route) {
  const m = new RegExp(`(\\S*)/${route}/([A-Za-z0-9_-]+)`).exec(mail?.text ?? "");
  return m ? { origin: m[1], token: m[2] } : null;
}

function form(fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** Concatenated, unescaped RSC flight data embedded in an HTML page. */
function flightText(html) {
  let out = "";
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try {
      out += JSON.parse(`"${m[1]}"`);
    } catch {
      // ignore
    }
  }
  return out;
}

const tag = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const PASSWORD = `Smoke-${randomBytes(6).toString("hex")}`;

const COMMENT_ACTION = "src/components/comments/actions.ts#addCommentAction";

/** A valid 2x2 PNG. */
const PNG_2X2 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4EWBzIsCGAUIBACduBVHnvcpNAAAAAElFTkSuQmCC",
  "base64",
);

// --------------------------------------------------------------- steps ----

/** start -> PUT -> complete; returns the file id (or undefined after a failed check). */
async function uploadFile(client, slug, name, type, bytes) {
  const start = await client.action(`/w/${slug}/files`, "src/app/w/[slug]/files/actions.ts#startUploadAction", [
    slug,
    { name, size: bytes.byteLength, type, folderId: null },
  ]);
  const target = start.result?.data;
  if (!check(`${client.label}: start upload of ${name}`, start.result?.ok === true && target?.url, JSON.stringify(start.result))) return undefined;
  const put = await client.fetch(target.url, { method: target.method, headers: target.headers, body: bytes });
  await put.text();
  const done = await client.action(`/w/${slug}/files`, "src/app/w/[slug]/files/actions.ts#completeUploadAction", [slug, target.token]);
  const id = done.result?.data?.id;
  return check(`${client.label}: upload of ${name} completes`, put.ok && done.result?.ok === true && id, `${put.status} ${JSON.stringify(done.result)}`) ? id : undefined;
}

/** Security headers on a page and on API responses, /api/health and the cron guard. */
async function securityHeaders(anon, home) {
  const h = home.res.headers;
  const csp = h.get("content-security-policy") ?? "";
  const nonce = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(csp)?.[1];
  check(
    "page: CSP with a per-request script nonce, strict-dynamic, no unsafe-inline scripts",
    Boolean(nonce) &&
      /script-src [^;]*'strict-dynamic'/.test(csp) &&
      !/script-src [^;]*'unsafe-inline'/.test(csp) &&
      csp.includes("object-src 'none'") &&
      csp.includes("frame-ancestors 'none'"),
    csp,
  );
  check("page: the nonce is on the page's scripts", Boolean(nonce) && home.text.includes(`nonce="${nonce}"`));
  const again = await anon.get("/");
  const nonce2 = /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(again.res.headers.get("content-security-policy") ?? "")?.[1];
  check("page: the nonce changes on every request", Boolean(nonce2) && nonce2 !== nonce);
  check(
    "page: nosniff, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy",
    h.get("x-content-type-options") === "nosniff" &&
      h.get("x-frame-options") === "DENY" &&
      h.get("referrer-policy") === "strict-origin-when-cross-origin" &&
      (h.get("permissions-policy") ?? "").includes("camera=()") &&
      !h.has("x-powered-by"),
    JSON.stringify(Object.fromEntries(h)).slice(0, 160),
  );
  const tokenPage = await anon.get("/reset-password/abcdefghijklmnopqrstuvwxyz");
  check("token page: Referrer-Policy no-referrer", tokenPage.res.headers.get("referrer-policy") === "no-referrer");

  const health = await anon.get("/api/health");
  let healthBody = null;
  try {
    healthBody = JSON.parse(health.text);
  } catch {
    // checked below
  }
  check("/api/health -> 200 {status: ok, db: ok}", health.status === 200 && healthBody?.status === "ok" && healthBody?.db === "ok", `${health.status} ${health.text}`);
  const ah = health.res.headers;
  check(
    "API response: nosniff, no-referrer, no-store, no page CSP",
    ah.get("x-content-type-options") === "nosniff" &&
      ah.get("referrer-policy") === "no-referrer" &&
      (ah.get("cache-control") ?? "").includes("no-store") &&
      !ah.has("content-security-policy"),
    JSON.stringify(Object.fromEntries(ah)).slice(0, 160),
  );
  const cron = await anon.get("/api/cron/cleanup");
  check("/api/cron/cleanup without the secret -> 401 (start the server with CRON_SECRET)", cron.status === 401, String(cron.status));
  const cronBad = await anon.fetch("/api/cron/cleanup", { headers: { Authorization: "Bearer wrong-secret-0123456789" } });
  await cronBad.text();
  check("/api/cron/cleanup with a wrong bearer -> 401", cronBad.status === 401, String(cronBad.status));
}

async function register(client, name, email) {
  await client.get("/register");
  const r = await client.action("/register", "src/app/(auth)/actions.ts#registerAction", [
    {},
    form({ name, email, password: PASSWORD, callbackUrl: "/onboarding" }),
  ]);
  must(`${client.label}: register via registerAction redirects`, r.redirect?.includes("/onboarding"), `${r.status} ${r.redirect}`);
  must(`${client.label}: register sets a session cookie`, client.cookies.has("authjs.session-token"));
}

async function credentialsLogin(client, email, password = PASSWORD) {
  const csrfRes = await client.get("/api/auth/csrf");
  const { csrfToken } = JSON.parse(csrfRes.text);
  must(`${client.label}: /api/auth/csrf returns a token`, typeof csrfToken === "string" && csrfToken.length > 10);
  const res = await client.fetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password, csrfToken, callbackUrl: `${BASE}/app` }),
  });
  await res.text();
  must(
    `${client.label}: Auth.js credentials login (CSRF) sets a session`,
    res.status === 302 && client.cookies.has("authjs.session-token") && !res.headers.get("location")?.includes("error"),
    `${res.status} ${res.headers.get("location")}`,
  );
  const session = JSON.parse((await client.get("/api/auth/session")).text);
  must(`${client.label}: session carries user id and email`, Boolean(session?.user?.id) && session.user.email === email);
  return session.user.id;
}

async function createWorkspace(client, name, slug) {
  const r = await client.action("/onboarding", "src/app/(account)/onboarding/actions.ts#createWorkspaceAction", [
    {},
    form({ name, slug }),
  ]);
  must(`${client.label}: createWorkspaceAction redirects to /w/${slug}`, r.redirect?.includes(`/w/${slug}`), `${r.status} ${r.redirect}`);
  const page = await client.get(`/w/${slug}`);
  must(`${client.label}: workspace overview loads`, page.status === 200 && page.text.includes(name), String(page.status));
}

async function main() {
  console.log(`Smoke test against ${BASE} (tag ${tag})\n`);
  const health = await fetch(`${BASE}/login`).catch(() => null);
  must("server is reachable", health?.status === 200, String(health?.status));

  // --- signed-out behaviour
  const anon = new Client("anon");
  const anonW = await anon.get("/w/anything");
  check("signed out: /w/* redirects to /login", anonW.status === 307 && anonW.location?.includes("/login?callbackUrl="));
  const anonAccount = await anon.get("/account");
  check("signed out: /account redirects to /login", anonAccount.status === 307 && anonAccount.location?.includes("/login?callbackUrl="), `${anonAccount.status} ${anonAccount.location}`);
  const anonApi = await anon.get("/api/chat/anything/messages");
  check("signed out: /api/* answers 401 JSON (no redirect)", anonApi.status === 401 && anonApi.text.includes("error"), String(anonApi.status));
  const fakeToken = "abcdefghijklmnopqrstuvwxyz";
  for (const path of ["/forgot-password", `/reset-password/${fakeToken}`, `/verify-email/${fakeToken}`]) {
    const r = await anon.get(path);
    check(`signed out: ${path.replace(fakeToken, "<token>")} is public (200)`, r.status === 200, `${r.status} ${r.location ?? ""}`);
  }
  const anonExpired = await anon.get("/session-expired");
  check("signed out: /session-expired sends to /login", [302, 303, 307].includes(anonExpired.status) && anonExpired.location?.includes("/login"), `${anonExpired.status} ${anonExpired.location}`);
  for (const [path, type] of [["/icon.svg", "image/svg+xml"], ["/favicon.ico", "image/"], ["/apple-icon.png", "image/png"]]) {
    const r = await anon.fetch(path);
    const ct = r.headers.get("content-type") ?? "";
    await r.arrayBuffer();
    check(`signed out: ${path} is served (200 ${type})`, r.status === 200 && ct.startsWith(type), `${r.status} ${ct}`);
  }
  const home = await anon.get("/");
  await securityHeaders(anon, home);
  check("landing page links the favicon and apple-touch-icon", home.text.includes('rel="apple-touch-icon"') && home.text.includes("/favicon.ico"), String(home.status));
  const anonOutbox = await anon.get("/dev/outbox");
  check("signed out: /dev/outbox -> 404", anonOutbox.status === 404, String(anonOutbox.status));

  // --- user A
  const emailA = `smoke-a-${tag}@hestia.test`;
  const emailB = `smoke-b-${tag}@hestia.test`;
  const slugA = `smoke-a-${tag}`;
  const slugB = `smoke-b-${tag}`;
  const nameA = `Smoke A ${tag}`;
  const nameB = `Smoke B ${tag}`;

  const regA = new Client("A(register)");
  await register(regA, "Smoke Kullanıcı A", emailA);

  const A = new Client("A");
  const userAId = await credentialsLogin(A, emailA);
  const wrong = new Client("wrong-pass");
  const csrf = JSON.parse((await wrong.get("/api/auth/csrf")).text).csrfToken;
  const bad = await wrong.fetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: emailA, password: "yanlis-sifre", csrfToken: csrf }),
  });
  check("wrong password does not create a session", !wrong.cookies.has("authjs.session-token") && bad.headers.get("location")?.includes("error="));

  await createWorkspace(A, nameA, slugA);

  // --- message board
  const postTitle = `Smoke duyuru ${tag}`;
  const p = await A.action(`/w/${slugA}/messages/new`, "src/app/w/[slug]/messages/actions.ts#createPostAction", [
    slugA,
    {},
    form({ title: postTitle, body: "Merhaba ekip, detaylar: https://example.com/plan" }),
  ]);
  const postId = /\/messages\/([^/;?]+)/.exec(p.redirect ?? "")?.[1];
  must("A: createPostAction redirects to the new post", Boolean(postId), `${p.status} ${p.redirect}`);
  const commentBody = `Smoke yorum ${tag}`;
  const c = await A.action(`/w/${slugA}/messages/${postId}`, COMMENT_ACTION, [
    slugA,
    "post",
    postId,
    {},
    form({ body: commentBody }),
  ]);
  check("A: addCommentAction (post) returns ok", c.result?.ok === true, JSON.stringify(c.result));
  const postPage = await A.get(`/w/${slugA}/messages/${postId}`);
  check(
    "A: post page shows title, comment and a safe link",
    postPage.status === 200 &&
      postPage.text.includes(postTitle) &&
      postPage.text.includes(commentBody) &&
      postPage.text.includes('href="https://example.com/plan"'),
  );
  const list = await A.get(`/w/${slugA}/messages`);
  check("A: messages list shows the post", list.status === 200 && list.text.includes(postTitle));

  // --- to-dos
  const listName = `Smoke liste ${tag}`;
  const itemTitle = `Smoke görev ${tag}`;
  const l = await A.action(`/w/${slugA}/todos`, "src/app/w/[slug]/todos/actions.ts#createListAction", [
    slugA,
    {},
    form({ name: listName, description: "" }),
  ]);
  check("A: createListAction returns ok", l.result?.ok === true, JSON.stringify(l.result));
  const todosPage = await A.get(`/w/${slugA}/todos`);
  const listId =
    /name="listId"[^>]*value="([^"]+)"/.exec(todosPage.text)?.[1] ??
    /value="([^"]+)"[^>]*name="listId"/.exec(todosPage.text)?.[1];
  must("A: todos page shows the list with its add-item form", Boolean(listId) && todosPage.text.includes(listName));
  const i = await A.action(`/w/${slugA}/todos`, "src/app/w/[slug]/todos/actions.ts#createItemAction", [
    slugA,
    {},
    form({ listId, title: itemTitle }),
  ]);
  check("A: createItemAction returns ok", i.result?.ok === true, JSON.stringify(i.result));
  const todosAfter = await A.get(`/w/${slugA}/todos`);
  const itemId = new RegExp(`"id":"([^"]+)","listId":"${listId}","title":"${itemTitle}"`).exec(
    flightText(todosAfter.text),
  )?.[1];
  check("A: todos page shows the item", todosAfter.text.includes(itemTitle) && Boolean(itemId));
  const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // Istanbul date
  if (itemId) {
    const u = await A.action(`/w/${slugA}/todos`, "src/app/w/[slug]/todos/actions.ts#updateItemAction", [
      slugA,
      {},
      form({ id: itemId, title: itemTitle, notes: "", assigneeId: userAId, dueDate: today }),
    ]);
    check("A: updateItemAction assigns the item to A with a due date", u.result?.ok === true, JSON.stringify(u.result));
  }

  // --- calendar
  const eventTitle = `Smoke toplantı ${tag}`;
  const inTwoDays = new Date(Date.now() + 3 * 3600_000 + 2 * 86400_000).toISOString().slice(0, 10);
  const e = await A.action(`/w/${slugA}/calendar`, "src/app/w/[slug]/calendar/actions.ts#createEventAction", [
    slugA,
    {},
    form({ title: eventTitle, description: "", location: "Zoom", startsAt: `${inTwoDays}T10:00`, endsAt: `${inTwoDays}T11:00` }),
  ]);
  check("A: createEventAction returns ok", e.result?.ok === true, JSON.stringify(e.result));
  const cal = await A.get(`/w/${slugA}/calendar?month=${inTwoDays.slice(0, 7)}`);
  check("A: calendar month shows the event", cal.status === 200 && cal.text.includes(eventTitle));

  // --- files: upload (3 steps) and byte-identical download
  const bytes = new Uint8Array(randomBytes(2048));
  const fileName = `smoke-${tag}.bin`;
  const start = await A.action(`/w/${slugA}/files`, "src/app/w/[slug]/files/actions.ts#startUploadAction", [
    slugA,
    { name: fileName, size: bytes.byteLength, type: "application/octet-stream", folderId: null },
  ]);
  const pending = start.result?.data;
  must("A: startUploadAction returns an upload target", start.result?.ok === true && pending?.url, JSON.stringify(start.result));
  const put = await A.fetch(pending.url, { method: pending.method, headers: pending.headers, body: bytes });
  await put.text();
  check("A: PUT bytes to the upload target", put.ok, String(put.status));
  const replay = await A.fetch(pending.url, { method: pending.method, headers: pending.headers, body: bytes });
  await replay.text();
  check("A: replaying the upload token is rejected", replay.status === 409, String(replay.status));
  const done = await A.action(`/w/${slugA}/files`, "src/app/w/[slug]/files/actions.ts#completeUploadAction", [
    slugA,
    pending.token,
  ]);
  const fileId = done.result?.data?.id;
  must("A: completeUploadAction creates the file", done.result?.ok === true && fileId, JSON.stringify(done.result));
  const dl = await A.fetch(`/api/files/${fileId}`);
  const dlBytes = new Uint8Array(await dl.arrayBuffer());
  check(
    "A: download is byte-identical, as an attachment with nosniff",
    dl.status === 200 &&
      Buffer.from(dlBytes).equals(Buffer.from(bytes)) &&
      (dl.headers.get("content-disposition") ?? "").startsWith("attachment") &&
      dl.headers.get("x-content-type-options") === "nosniff",
    `${dl.status} ${dlBytes.byteLength}B`,
  );
  const files = await A.get(`/w/${slugA}/files`);
  check("A: files page lists the upload", files.status === 200 && files.text.includes(fileName));

  const eventId = new RegExp(`"id":"([^"]+)","title":"${eventTitle}"`).exec(flightText(cal.text))?.[1];
  check("A: calendar flight data carries the event id", Boolean(eventId));

  // --- document
  const docTitle = `Smoke doküman ${tag}`;
  const d = await A.action(`/w/${slugA}/files/docs/new`, "src/app/w/[slug]/files/actions.ts#createDocumentAction", [
    slugA,
    {},
    form({ title: docTitle, content: "# Başlık\n\nGövde", folderId: "" }),
  ]);
  const docId = /\/files\/docs\/([^/;?]+)/.exec(d.redirect ?? "")?.[1];
  check("A: createDocumentAction redirects to the document", Boolean(docId), `${d.status} ${d.redirect}`);

  // --- comments on a to-do, an event and a document, shown on their detail pages
  const subjects = [
    ["todo", itemId, `/w/${slugA}/todos/${itemId}`],
    ["event", eventId, `/w/${slugA}/calendar/${eventId}`],
    ["document", docId, `/w/${slugA}/files/docs/${docId}`],
  ].filter(([, id]) => Boolean(id));
  for (const [type, id, page] of subjects) {
    const body = `Smoke ${type} yorumu ${tag}`;
    const r = await A.action(page, COMMENT_ACTION, [slugA, type, id, {}, form({ body })]);
    const shown = await A.get(page);
    check(`A: comment on a ${type} is saved and shown on its page`, r.result?.ok === true && shown.status === 200 && shown.text.includes(body), `${JSON.stringify(r.result)} ${shown.status}`);
  }

  // --- inline previews: an HTML file declared as image/png is never served inline
  const html = new TextEncoder().encode(`<html><script>alert(1)</script>${tag}</html>`);
  const fakePng = await uploadFile(A, slugA, `sahte-${tag}.png`, "image/png", html);
  if (fakePng) {
    const r = await A.fetch(`/api/files/${fakePng}/inline`);
    const body = await r.text();
    check("A: inline endpoint refuses HTML uploaded as image/png (415)", r.status === 415 && !body.includes("<script>"), String(r.status));
  }
  const realPng = await uploadFile(A, slugA, `logo-${tag}.png`, "image/png", PNG_2X2);
  if (realPng) {
    const r = await A.fetch(`/api/files/${realPng}/inline`);
    await r.arrayBuffer();
    const csp = r.headers.get("content-security-policy") ?? "";
    check(
      "A: inline endpoint serves a real PNG inline, sandboxed and nosniff",
      r.status === 200 &&
        r.headers.get("content-type") === "image/png" &&
        (r.headers.get("content-disposition") ?? "").startsWith("inline") &&
        csp.includes("sandbox") &&
        csp.includes("default-src 'none'") &&
        r.headers.get("x-content-type-options") === "nosniff",
      `${r.status} ${r.headers.get("content-type")} ${csp}`,
    );
  }

  // --- chat: send via action, read via the polling endpoint
  const chatBody = `Smoke sohbet ${tag}`;
  const before = JSON.parse((await A.get(`/api/chat/${slugA}/messages`)).text);
  const sent = await A.action(`/w/${slugA}/chat`, "src/app/w/[slug]/chat/actions.ts#sendChatMessageAction", [
    slugA,
    { body: chatBody, clientId: `smoke${tag}` },
  ]);
  check("A: sendChatMessageAction returns the message", sent.result?.ok === true && sent.result.data?.body === chatBody, JSON.stringify(sent.result));
  const latest = JSON.parse((await A.get(`/api/chat/${slugA}/messages`)).text);
  check("A: chat newest page contains the message", latest.messages?.some((m) => m.body === chatBody));
  const cursor = sent.result?.data?.cursor;
  if (before.messages?.length === 0 && cursor) {
    // A cursor just below the new one: poll ?after= must return it.
    const ms = Number(cursor.split("_")[0]) - 1;
    const after = JSON.parse((await A.get(`/api/chat/${slugA}/messages?after=${ms}_0&from=${ms}_0`)).text);
    check("A: chat polling (?after=&from=) returns the message and liveIds", after.messages?.some((m) => m.body === chatBody) && after.liveIds?.includes(sent.result.data.id));
  }
  const chatPage = await A.get(`/w/${slugA}/chat`);
  const workspaceAId = /"workspaceId":"([^"]+)"/.exec(flightText(chatPage.text))?.[1];
  check("A: chat page renders with the message", chatPage.status === 200 && chatPage.text.includes(chatBody) && Boolean(workspaceAId));

  // --- overview widgets
  const overview = await A.get(`/w/${slugA}`);
  check("A: overview shows latest post", overview.text.includes(postTitle));
  check("A: overview shows my open to-do", overview.text.includes(itemTitle));
  check("A: overview shows the upcoming event", overview.text.includes(eventTitle));
  check("A: overview shows the recent file", overview.text.includes(fileName));
  check(
    "A: shell has the search box and the notification bell",
    overview.text.includes(`action="/w/${slugA}/search"`) && overview.text.includes('aria-label="Bildirimler"'),
  );

  // --- activity feed
  const activity = await A.get(`/w/${slugA}/activity`);
  check(
    "A: activity page lists the post, list, event and upload",
    activity.status === 200 &&
      activity.text.includes(postTitle) &&
      activity.text.includes(listName) &&
      activity.text.includes(eventTitle) &&
      activity.text.includes(fileName),
    String(activity.status),
  );
  check("A: overview has the Son hareketler section", overview.text.includes('aria-label="Son hareketler"'));

  // --- search
  const searchQ = encodeURIComponent(`duyuru ${tag}`);
  const search = await A.get(`/w/${slugA}/search?q=${searchQ}`);
  check(
    "A: search finds A's post",
    search.status === 200 && search.text.includes(`href="/w/${slugA}/messages/${postId}"`),
    String(search.status),
  );
  const searchNone = await A.get(`/w/${slugA}/search?q=${encodeURIComponent(`yok-${tag}`)}`);
  check("A: search with no match shows the empty state", searchNone.status === 200 && searchNone.text.includes("Sonuç bulunamadı"));

  // --- account
  const account = await A.get("/account");
  check(
    "A: /account loads signed in, with a way back to /app",
    account.status === 200 && account.text.includes("Hesabım") && account.text.includes(emailA) && account.text.includes('href="/app"'),
    String(account.status),
  );

  // --- notifications (A alone: nothing yet)
  const aNotif = await A.get(`/w/${slugA}/notifications`);
  check("A: notifications page loads with the empty state", aNotif.status === 200 && aNotif.text.includes("Henüz bildiriminiz yok"), String(aNotif.status));

  // --- Pusher channel auth for A's own channel
  const channelA = `private-workspace-${workspaceAId}`;
  const ownAuth = await A.fetch("/api/pusher/auth", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ socket_id: "1234.5678", channel_name: channelA }),
  });
  const ownAuthBody = await ownAuth.text();
  const pusherConfigured = ownAuth.status !== 404;
  if (pusherConfigured) {
    check("A: Pusher auth signs A's own channel", ownAuth.status === 200 && ownAuthBody.includes('"auth"'), String(ownAuth.status));
  } else {
    check("Pusher not configured: auth endpoint answers 404 without a signature", !ownAuthBody.includes('"auth"'));
  }

  // --- user B with their own workspace
  const regB = new Client("B(register)");
  await register(regB, "Smoke Kullanıcı B", emailB);
  const B = new Client("B");
  const userBId = await credentialsLogin(B, emailB);
  await createWorkspace(B, nameB, slugB);

  // --- isolation over HTTP
  for (const seg of ["", "/messages", "/todos", "/files", "/calendar", "/chat", "/activity", "/settings", "/messages/new"]) {
    const r = await B.get(`/w/${slugA}${seg}`);
    check(`ISOLATION: B GET /w/<A>${seg} -> 404 without A's data`, r.status === 404 && !r.text.includes(nameA), String(r.status));
  }
  const bSearch = await B.get(`/w/${slugA}/search?q=${searchQ}`);
  check("ISOLATION: B GET /w/<A>/search -> 404 without A's post", bSearch.status === 404 && !bSearch.text.includes(postTitle) && !bSearch.text.includes(postId), String(bSearch.status));
  const bOwnSearch = await B.get(`/w/${slugB}/search?q=${searchQ}`);
  check("ISOLATION: B searching its own workspace does not find A's post", bOwnSearch.status === 200 && !bOwnSearch.text.includes(postId), String(bOwnSearch.status));
  const bActivity = await B.get(`/w/${slugA}/activity`);
  check(
    "ISOLATION: non-member B GET /w/<A>/activity -> 404 without A's activity",
    bActivity.status === 404 && !bActivity.text.includes(postTitle) && !bActivity.text.includes(fileName),
    String(bActivity.status),
  );
  const bNotifA = await B.get(`/w/${slugA}/notifications`);
  check("ISOLATION: non-member B GET /w/<A>/notifications -> 404", bNotifA.status === 404 && !bNotifA.text.includes(nameA), String(bNotifA.status));
  const bNotifApi = await B.get(`/api/notifications/${slugA}`);
  check("ISOLATION: non-member B GET /api/notifications/<A> -> 404", bNotifApi.status === 404 && !bNotifApi.text.includes('"unread"'), String(bNotifApi.status));
  const bPost = await B.get(`/w/${slugA}/messages/${postId}`);
  check("ISOLATION: B GET A's post by id -> 404", bPost.status === 404 && !bPost.text.includes(postTitle), String(bPost.status));
  const bOwnPostUrl = await B.get(`/w/${slugB}/messages/${postId}`);
  check("ISOLATION: B GET A's post id under B's slug -> 404", bOwnPostUrl.status === 404 && !bOwnPostUrl.text.includes(postTitle), String(bOwnPostUrl.status));
  const longPost = await B.get(`/w/${slugB}/messages/${"x".repeat(65)}`);
  check("Post id over 64 chars -> 404 (not 500)", longPost.status === 404, String(longPost.status));
  check("404 page is the Turkish app page", longPost.text.includes("Sayfa bulunamadı") && !longPost.text.includes("This page could not be found"));
  const nonMember404 = await B.get(`/w/${slugA}`);
  check("Non-member workspace 404 shows the Turkish page", nonMember404.text.includes("Sayfa bulunamadı"));
  const bFile = await B.fetch(`/api/files/${fileId}`);
  const bFileBody = Buffer.from(await bFile.arrayBuffer());
  check("ISOLATION: B download of A's file -> 404/403, no bytes", [403, 404].includes(bFile.status) && !bFileBody.equals(Buffer.from(bytes)), String(bFile.status));
  if (realPng) {
    const r = await B.fetch(`/api/files/${realPng}/inline`);
    const body = Buffer.from(await r.arrayBuffer());
    check("ISOLATION: non-member B GET A's inline file -> 404, no bytes", r.status === 404 && !body.equals(Buffer.from(PNG_2X2)), String(r.status));
  }
  for (const [type, id, page] of subjects) {
    const r = await B.get(page);
    check(`ISOLATION: non-member B GET A's ${type} page -> 404`, r.status === 404 && !r.text.includes(`Smoke ${type} yorumu ${tag}`), String(r.status));
    const own = await B.get(page.replace(`/w/${slugA}/`, `/w/${slugB}/`));
    check(`ISOLATION: A's ${type} id under B's slug -> 404`, own.status === 404, String(own.status));
    const w = await B.action(`/w/${slugB}`, COMMENT_ACTION, [slugB, type, id, {}, form({ body: `B sızma ${type} ${tag}` })]);
    const w2 = await B.action(`/w/${slugB}`, COMMENT_ACTION, [slugA, type, id, {}, form({ body: `B sızma ${type} ${tag}` })]);
    const after = await A.get(page);
    check(
      `ISOLATION: B cannot comment on A's ${type} (own slug or A's slug)`,
      w.result?.ok !== true && w2.result?.ok !== true && !after.text.includes(`B sızma ${type}`),
      `${JSON.stringify(w.result)} ${JSON.stringify(w2.result)}`,
    );
  }
  const bChat = await B.get(`/api/chat/${slugA}/messages`);
  check("ISOLATION: B polling A's chat -> 404/403", [403, 404].includes(bChat.status) && !bChat.text.includes(chatBody), String(bChat.status));
  const bPusher = await B.fetch("/api/pusher/auth", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ socket_id: "1234.5678", channel_name: channelA }),
  });
  const bPusherBody = await bPusher.text();
  check(
    `ISOLATION: B Pusher auth for A's channel -> ${pusherConfigured ? "403" : "404 (unconfigured)"}, never a signature`,
    (pusherConfigured ? bPusher.status === 403 : [403, 404, 503].includes(bPusher.status)) && !bPusherBody.includes('"auth"'),
    String(bPusher.status),
  );
  const bWrite = await B.action(`/w/${slugB}/messages/new`, "src/app/w/[slug]/messages/actions.ts#createPostAction", [
    slugA,
    {},
    form({ title: `B sızma ${tag}`, body: "x" }),
  ]);
  const aListAfter = await A.get(`/w/${slugA}/messages`);
  check(
    "ISOLATION: B calling createPostAction with A's slug writes nothing",
    !bWrite.redirect?.includes(`/w/${slugA}/messages/`) && !aListAfter.text.includes(`B sızma ${tag}`),
    String(bWrite.status),
  );
  const bComment = await B.action(`/w/${slugB}`, COMMENT_ACTION, [
    slugB,
    "post",
    postId,
    {},
    form({ body: `B yorum ${tag}` }),
  ]);
  const aPostAfter = await A.get(`/w/${slugA}/messages/${postId}`);
  check(
    "ISOLATION: B commenting on A's post id through B's own slug is rejected",
    bComment.result?.ok !== true && !aPostAfter.text.includes(`B yorum ${tag}`),
    JSON.stringify(bComment.result),
  );
  const bChatWrite = await B.action(`/w/${slugB}/chat`, "src/app/w/[slug]/chat/actions.ts#sendChatMessageAction", [
    slugA,
    { body: `B chat sızma ${tag}` },
  ]);
  const aChatAfter = JSON.parse((await A.get(`/api/chat/${slugA}/messages`)).text);
  check(
    "ISOLATION: B sending chat to A's slug writes nothing",
    bChatWrite.result?.ok !== true && !aChatAfter.messages?.some((m) => m.body.includes("B chat sızma")),
    String(bChatWrite.status),
  );
  const bInvite = await B.action(`/w/${slugB}/settings`, "src/app/w/[slug]/settings/actions.ts#inviteMemberAction", [
    slugA,
    {},
    form({ email: emailB, role: "ADMIN" }),
  ]);
  check("ISOLATION: B cannot create an invite for A's workspace", bInvite.result?.ok !== true && !bInvite.result?.data, String(bInvite.status));
  const aSeesB = await A.get(`/w/${slugB}`);
  check("ISOLATION: A GET /w/<B> -> 404", aSeesB.status === 404 && !aSeesB.text.includes(nameB), String(aSeesB.status));

  // --- invite B into A, accept, then B can read A
  const inv = await A.action(`/w/${slugA}/settings`, "src/app/w/[slug]/settings/actions.ts#inviteMemberAction", [
    slugA,
    {},
    form({ email: emailB, role: "MEMBER" }),
  ]);
  const inviteUrl = inv.result?.data?.inviteUrl;
  const token = /\/invite\/([^/?#]+)/.exec(inviteUrl ?? "")?.[1];
  must("A: inviteMemberAction returns an invite link", Boolean(token), JSON.stringify(inv.result));
  check("A: invite link points at this server", inviteUrl.startsWith(BASE), inviteUrl);
  const invitePage = await B.get(`/invite/${token}`);
  check("B: invite page loads and names workspace A", invitePage.status === 200 && invitePage.text.includes(nameA), String(invitePage.status));
  const acc = await B.action(`/invite/${token}`, "src/app/invite/[token]/actions.ts#acceptInvitationAction", [{}, form({ token })]);
  check("B: acceptInvitationAction redirects into workspace A", acc.redirect?.includes(`/w/${slugA}`), `${acc.status} ${acc.redirect}`);
  const bMessages = await B.get(`/w/${slugA}/messages`);
  check("B (member now): /w/<A>/messages loads and shows A's post", bMessages.status === 200 && bMessages.text.includes(postTitle), String(bMessages.status));
  const bFile2 = await B.fetch(`/api/files/${fileId}`);
  const bFile2Body = Buffer.from(await bFile2.arrayBuffer());
  check("B (member now): can download A's file", bFile2.status === 200 && bFile2Body.equals(Buffer.from(bytes)), String(bFile2.status));
  const bChat2 = JSON.parse((await B.get(`/api/chat/${slugA}/messages`)).text);
  check("B (member now): chat polling shows A's message", bChat2.messages?.some((m) => m.body === chatBody));

  // --- notifications after B joined
  const aNotif2 = await A.get(`/w/${slugA}/notifications`);
  check("A (OWNER): notified that B joined", aNotif2.status === 200 && aNotif2.text.includes("çalışma alanına katıldı"), String(aNotif2.status));
  const bItemTitle = `Smoke B görevi ${tag}`;
  // The quick-add form only takes a title; assigning goes through the edit dialog (updateItemAction).
  const created = await A.action(`/w/${slugA}/todos`, "src/app/w/[slug]/todos/actions.ts#createItemAction", [
    slugA,
    {},
    form({ listId, title: bItemTitle }),
  ]);
  const bItemId = new RegExp(`"id":"([^"]+)","listId":"${listId}","title":"${bItemTitle}"`).exec(
    flightText((await A.get(`/w/${slugA}/todos`)).text),
  )?.[1];
  check("A: createItemAction adds a to-do for B", created.result?.ok === true && Boolean(bItemId), JSON.stringify(created.result));
  const assign = await A.action(`/w/${slugA}/todos`, "src/app/w/[slug]/todos/actions.ts#updateItemAction", [
    slugA,
    {},
    form({ id: bItemId ?? "", title: bItemTitle, notes: "", assigneeId: userBId, dueDate: "" }),
  ]);
  check("A: updateItemAction assigns the to-do to B", assign.result?.ok === true, JSON.stringify(assign.result));
  const bNotif = await B.get(`/w/${slugA}/notifications`);
  check(
    "B: notifications page shows the assignment",
    bNotif.status === 200 && bNotif.text.includes("size bir görev atadı") && bNotif.text.includes(bItemTitle),
    String(bNotif.status),
  );
  const bSummary = JSON.parse((await B.get(`/api/notifications/${slugA}`)).text);
  const bAssigned = bSummary.items?.find((n) => n.type === "TODO_ASSIGNED");
  check("B: bell endpoint reports unread and the assignment", bSummary.unread >= 1 && Boolean(bAssigned), JSON.stringify(bSummary).slice(0, 120));
  const aSummary = JSON.parse((await A.get(`/api/notifications/${slugA}`)).text);
  check("A: bell endpoint does not show B's notification", !aSummary.items?.some((n) => n.id === bAssigned?.id));
  if (bAssigned) {
    const aOpensB = await A.action(`/w/${slugA}/notifications`, "src/app/w/[slug]/notifications/actions.ts#openNotificationAction", [
      slugA,
      {},
      form({ id: bAssigned.id }),
    ]);
    check("ISOLATION: A cannot open/mark B's notification", aOpensB.result?.ok === false && !aOpensB.redirect, JSON.stringify(aOpensB.result));
    const opened = await B.action(`/w/${slugA}/notifications`, "src/app/w/[slug]/notifications/actions.ts#openNotificationAction", [
      slugA,
      {},
      form({ id: bAssigned.id }),
    ]);
    check("B: opening the notification redirects to the to-dos", opened.redirect?.includes(`/w/${slugA}/todos`), `${opened.status} ${opened.redirect}`);
    const afterOpen = JSON.parse((await B.get(`/api/notifications/${slugA}`)).text);
    check("B: the opened notification is now read", afterOpen.items?.find((n) => n.id === bAssigned.id)?.readAt);
  }
  const allRead = await B.action(`/w/${slugA}/notifications`, "src/app/w/[slug]/notifications/actions.ts#markAllReadAction", [
    slugA,
    {},
    form({}),
  ]);
  const bAfterAll = JSON.parse((await B.get(`/api/notifications/${slugA}`)).text);
  check("B: markAllReadAction clears the unread count", allRead.result?.ok === true && bAfterAll.unread === 0, JSON.stringify(allRead.result));
  // A third user cannot reuse B's (accepted, email-bound) invite token.
  const C = new Client("C");
  await register(C, "Smoke Kullanıcı C", `smoke-c-${tag}@hestia.test`);
  const reuse = await C.action(`/invite/${token}`, "src/app/invite/[token]/actions.ts#acceptInvitationAction", [{}, form({ token })]);
  const cSeesA = await C.get(`/w/${slugA}/messages`);
  const cNotif = await C.get(`/w/${slugA}/notifications`);
  check("ISOLATION: non-member C GET /w/<A>/notifications -> 404", cNotif.status === 404, String(cNotif.status));
  check(
    "ISOLATION: another user cannot reuse B's accepted invite token",
    !reuse.redirect?.includes(`/w/${slugA}`) && cSeesA.status === 404,
    `${JSON.stringify(reuse.result)} ${cSeesA.status}`,
  );
  const bSettings = await B.action(`/w/${slugA}/settings`, "src/app/w/[slug]/settings/actions.ts#inviteMemberAction", [
    slugA,
    {},
    form({ email: `x-${tag}@hestia.test`, role: "MEMBER" }),
  ]);
  check("B (MEMBER): cannot create invites in A (needs ADMIN)", bSettings.result?.ok !== true, String(bSettings.status));

  // --- mailed account flows: verify email, forgot/reset password, session revocation
  await accountSecurity(B, emailB);

  // --- summary
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exitCode = 1;
  }
}

async function accountSecurity(B, emailB) {
  const emailD = `smoke-d-${tag}@hestia.test`;
  const unknown = `smoke-unknown-${tag}@hestia.test`;
  const D = new Client("D");
  await register(D, "Smoke Kullanıcı D", emailD);
  const dOld = new Client("D(old session)");
  await credentialsLogin(dOld, emailD);

  // Registration queued a verify mail; the banner shows until it is used.
  const BANNER = 'aria-label="Hesap doğrulama uyarısı"';
  // D has no workspace yet: /onboarding is D's signed-in home (account shell).
  const dHome = await D.get("/onboarding");
  check("D: unverified user sees the verify-email banner", dHome.status === 200 && dHome.text.includes(BANNER), String(dHome.status));
  const verify = linkToken(outbox(emailD, "verify-email")[0], "verify-email");
  must("D: registration wrote a verify-email mail with a link", Boolean(verify?.token));
  check("D: emailed verify link uses AUTH_URL as origin", verify.origin === BASE, verify.origin);
  const verifyPage = await D.get(`/verify-email/${verify.token}`);
  const stillBanner = (await D.get("/onboarding")).text.includes(BANNER);
  check("D: opening the verify link (GET) does not verify yet", verifyPage.status === 200 && stillBanner);
  const v1 = await D.action(`/verify-email/${verify.token}`, "src/app/(auth)/actions.ts#verifyEmailAction", [{}, form({ token: verify.token })]);
  check("D: verifyEmailAction with the mailed token succeeds", v1.result?.ok === true, JSON.stringify(v1.result));
  const dHome2 = await D.get("/onboarding");
  check("D: banner is gone after verification", dHome2.status === 200 && !dHome2.text.includes(BANNER));
  const v2 = await D.action(`/verify-email/${verify.token}`, "src/app/(auth)/actions.ts#verifyEmailAction", [{}, form({ token: verify.token })]);
  check("D: the verify token cannot be used twice", v2.result?.ok === false, JSON.stringify(v2.result));

  // Forgot password: identical answers for a known and an unknown address.
  const anon = new Client("anon(forgot)");
  const forgotKnown = await anon.get("/forgot-password");
  const forgotUnknown = await anon.get(`/forgot-password?email=${encodeURIComponent(unknown)}`);
  check("forgot-password page loads signed out", forgotKnown.status === 200 && forgotUnknown.status === 200);
  const fKnown = await anon.action("/forgot-password", "src/app/(auth)/actions.ts#forgotPasswordAction", [{}, form({ email: emailD })]);
  const fUnknown = await anon.action("/forgot-password", "src/app/(auth)/actions.ts#forgotPasswordAction", [{}, form({ email: unknown })]);
  check(
    "forgot-password answers identically for a known and an unknown email",
    fKnown.status === fUnknown.status &&
      fKnown.result?.ok === true &&
      JSON.stringify(fKnown.result) === JSON.stringify(fUnknown.result),
    `${JSON.stringify(fKnown.result)} vs ${JSON.stringify(fUnknown.result)}`,
  );
  check("forgot-password for an unknown email writes no mail", outbox(unknown).length === 0);
  const reset = linkToken(outbox(emailD, "password-reset")[0], "reset-password");
  must("D: forgot-password wrote a reset mail with a link", Boolean(reset?.token));
  check("D: emailed reset link uses AUTH_URL as origin", reset.origin === BASE, reset.origin);

  // /dev/outbox: own mail only (skipped when the server runs without the flag).
  const dOutbox = await D.get("/dev/outbox");
  if (dOutbox.status === 404) {
    console.log("SKIP  /dev/outbox checks (start the server with ENABLE_DEV_OUTBOX=true)");
  } else {
    check("D: /dev/outbox shows D's reset mail", dOutbox.status === 200 && dOutbox.text.includes(`/reset-password/${reset.token}`), String(dOutbox.status));
    const bOutbox = await B.get("/dev/outbox");
    check(
      "ISOLATION: B's /dev/outbox never shows D's mail",
      bOutbox.status === 200 &&
        bOutbox.text.includes(emailB) &&
        !bOutbox.text.includes(emailD) &&
        !bOutbox.text.includes(reset.token) &&
        !bOutbox.text.includes(verify.token),
      String(bOutbox.status),
    );
    const q = encodeURIComponent(emailD);
    const bOutboxQ = await B.get(`/dev/outbox?to=${q}&email=${q}&user=${q}`);
    // (The query string itself is echoed in the RSC payload, so only D's tokens are checked here.)
    check(
      "ISOLATION: query parameters cannot widen /dev/outbox",
      bOutboxQ.status === 200 && !bOutboxQ.text.includes(reset.token) && !bOutboxQ.text.includes(verify.token),
    );
  }

  // Reset: new password works, every old session is revoked.
  const NEW_PASSWORD = `Yeni-${randomBytes(6).toString("hex")}`;
  const resetPage = await anon.get(`/reset-password/${reset.token}`);
  check("reset page loads for a signed-out browser", resetPage.status === 200, String(resetPage.status));
  const r1 = await anon.action(`/reset-password/${reset.token}`, "src/app/(auth)/actions.ts#resetPasswordAction", [
    {},
    form({ token: reset.token, password: NEW_PASSWORD }),
  ]);
  check("resetPasswordAction with the mailed token redirects to /login?reset=1", r1.redirect?.includes("/login?reset=1"), `${r1.status} ${r1.redirect} ${JSON.stringify(r1.result)}`);
  const oldApp = await dOld.get("/app");
  check("D: old session cookie is revoked after the reset (-> /session-expired)", oldApp.status === 307 && oldApp.location?.includes("/session-expired"), `${oldApp.status} ${oldApp.location}`);
  const oldApi = await dOld.get("/api/notifications/anything");
  check("D: revoked session gets 401 from the API", oldApi.status === 401, String(oldApi.status));
  // A revoked JWT on /invite/<token> must be cleared, not rendered as signed
  // out (the middleware would bounce /login back here: login loop).
  const invitePath = `/invite/${"r".repeat(32)}`;
  const revokedInvite = await dOld.get(invitePath);
  const expectedExpired = `/session-expired?callbackUrl=${encodeURIComponent(invitePath)}`;
  check(
    "D: revoked session on /invite/<token> -> /session-expired with the invite as callbackUrl",
    [302, 303, 307].includes(revokedInvite.status) && revokedInvite.location?.includes(expectedExpired),
    `${revokedInvite.status} ${revokedInvite.location}`,
  );
  const expired = await dOld.get(expectedExpired);
  check(
    "D: /session-expired clears the revoked cookie and lands on /login?expired=1 keeping the callbackUrl",
    [302, 303, 307].includes(expired.status) &&
      expired.location?.includes("/login?expired=1") &&
      expired.location?.includes(`callbackUrl=${encodeURIComponent(invitePath)}`) &&
      !dOld.cookies.has("authjs.session-token"),
    `${expired.status} ${expired.location}`,
  );
  const dSession = await D.get("/app");
  check("D: the other old session is revoked too", dSession.status === 307 && dSession.location?.includes("/session-expired"), `${dSession.status} ${dSession.location}`);

  const oldPass = new Client("D(old password)");
  const csrf = JSON.parse((await oldPass.get("/api/auth/csrf")).text).csrfToken;
  const bad = await oldPass.fetch("/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: emailD, password: PASSWORD, csrfToken: csrf }),
  });
  await bad.text();
  check("D: the old password no longer logs in", !oldPass.cookies.has("authjs.session-token"));
  const dNew = new Client("D(new password)");
  await credentialsLogin(dNew, emailD, NEW_PASSWORD);
  check("D: the new password logs in and the account pages load", (await dNew.get("/onboarding")).status === 200);

  const r2 = await anon.action(`/reset-password/${reset.token}`, "src/app/(auth)/actions.ts#resetPasswordAction", [
    {},
    form({ token: reset.token, password: `${NEW_PASSWORD}-2` }),
  ]);
  check("the reset token cannot be used twice", r2.result?.ok === false && !r2.redirect, `${r2.status} ${JSON.stringify(r2.result)}`);
  const stillNew = new Client("D(after reuse)");
  await credentialsLogin(stillNew, emailD, NEW_PASSWORD);
}

main().catch((e) => {
  console.error(e);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nAborted after ${results.length} checks (${failed} failed).`);
  process.exitCode = 1;
});
