import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  contentDisposition,
  createLocalDriver,
  createR2Driver,
  decodeTextPreview,
  generateStorageKey,
  inlineContentType,
  inlineCsp,
  inlineSpec,
  parseRange,
  sniffMatches,
  TEXT_PREVIEW_MAX_BYTES,
  thumbnailEligible,
  THUMBNAIL_MAX_BYTES,
  type StorageDriver,
} from "@/lib/storage";
import type { TenantContext } from "@/lib/tenant-context";
import {
  acceptLocalUpload,
  authorizeFileAccess,
  completeUpload,
  createFolder,
  createPendingUpload,
  getFileInline,
  getFilePreview,
  NOT_INLINE_MESSAGE,
  type FileInline,
} from "@/server/files";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect } from "./helpers";

// ----------------------------------------------------------- fixtures ----

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49,
  0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00,
  0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
const enc = new TextEncoder();
const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === "string" ? Array.from(enc.encode(p)) : p)));
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

const JPEG = bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], "JFIF", [0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const GIF = bytes("GIF89a", [1, 0, 1, 0, 0, 0, 0]);
const WEBP = bytes("RIFF", [0x1a, 0, 0, 0], "WEBPVP8 ", [0, 0, 0, 0]);
const AVIF = bytes(u32(28), "ftypavif", u32(0), "avifmif1miaf");
const PDF = bytes("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n");
const MP4 = bytes(u32(24), "ftypisom", u32(0x200), "isomiso2", u32(8), "free");
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);
const MP3 = bytes("ID3", [4, 0, 0, 0, 0, 0, 0]);
/** 44-byte WAV header + 56 data bytes (values 0..55) = 100 bytes. */
const WAV = bytes("RIFF", [92, 0, 0, 0], "WAVEfmt ", [16, 0, 0, 0, 1, 0, 1, 0, 0x40, 0x1f, 0, 0, 0x40, 0x1f, 0, 0, 1, 0, 8, 0], "data", [
  56, 0, 0, 0,
], Array.from({ length: 56 }, (_, i) => i));
const HTML = bytes("<!doctype html><script>alert(document.cookie)</script>");
const SVG = bytes('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>');

let root: string;
let storage: StorageDriver;
let ctxA: TenantContext;
let ctxB: TenantContext;
let memberA: TenantContext;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function upload(ctx: TenantContext, name: string, type: string, body: Uint8Array, folderId: string | null = null) {
  const pending = await createPendingUpload(ctx, { name, size: body.byteLength, type, folderId }, storage);
  const put = await acceptLocalUpload(ctx.userId, pending.token, body, body.byteLength, storage);
  expect(put).toEqual({ ok: true, size: body.byteLength });
  return completeUpload(ctx, pending.token, storage);
}

function asBody(r: FileInline) {
  if (r.kind !== "body") throw new Error(`expected body, got ${r.kind}`);
  return r;
}

const refused = { code: "VALIDATION", message: NOT_INLINE_MESSAGE };
const nf = { code: "NOT_FOUND" };

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hestia-preview-"));
  storage = createLocalDriver(root);
  const ownerA = await createTestUser();
  const ownerB = await createTestUser();
  ({ ctx: ctxA } = await createTestWorkspace(ownerA.id));
  ({ ctx: ctxB } = await createTestWorkspace(ownerB.id));
  ({ ctx: memberA } = await createMember(ctxA.workspaceId, "MEMBER"));
});

afterAll(async () => {
  await cleanup();
  await disconnect();
  await rm(root, { recursive: true, force: true });
});

// ------------------------------------------------------- allow-list ----

describe("inline allow-list and magic numbers", () => {
  it("accepts real files of each allow-listed type", () => {
    const cases: [string, Uint8Array][] = [
      ["image/png", PNG],
      ["image/jpeg", JPEG],
      ["image/gif", GIF],
      ["image/webp", WEBP],
      ["image/avif", AVIF],
      ["application/pdf", PDF],
      ["video/mp4", MP4],
      ["video/webm", WEBM],
      ["audio/webm", WEBM],
      ["audio/mpeg", MP3],
      ["audio/wav", WAV],
    ];
    for (const [type, body] of cases) expect(sniffMatches(type, body), type).toBe(true);
  });

  it("refuses bytes that do not match the declared type", () => {
    expect(sniffMatches("image/png", HTML)).toBe(false);
    expect(sniffMatches("image/png", JPEG)).toBe(false);
    expect(sniffMatches("image/jpeg", PNG)).toBe(false);
    expect(sniffMatches("application/pdf", HTML)).toBe(false);
    expect(sniffMatches("video/mp4", AVIF)).toBe(false); // AVIF stills are not video
    expect(sniffMatches("image/webp", WAV)).toBe(false); // RIFF, but not WEBP
    expect(sniffMatches("image/png", PNG.subarray(0, 4))).toBe(false); // truncated
    expect(sniffMatches("image/png", new Uint8Array(0))).toBe(false);
  });

  it("never allows SVG, HTML, XML or text inline", () => {
    for (const t of [
      "image/svg+xml",
      "text/html",
      "application/xhtml+xml",
      "text/xml",
      "application/xml",
      "text/plain",
      "text/markdown",
      "application/json",
      "application/octet-stream",
      "application/javascript",
    ]) {
      expect(inlineSpec(t), t).toBeNull();
      expect(sniffMatches(t, SVG), t).toBe(false);
    }
  });

  it("serves the canonical type, never the stored string", () => {
    expect(inlineContentType("image/jpg")).toBe("image/jpeg");
    expect(inlineContentType("audio/x-wav")).toBe("audio/wav");
    expect(inlineContentType(" IMAGE/PNG ")).toBe("image/png");
    expect(inlineContentType("image/png; charset=utf-8")).toBeNull();
  });

  it("limits thumbnails to raster images under the size cap", () => {
    expect(thumbnailEligible("image/png", 1000)).toBe(true);
    expect(thumbnailEligible("image/png", THUMBNAIL_MAX_BYTES + 1)).toBe(false);
    expect(thumbnailEligible("image/png", 0)).toBe(false);
    expect(thumbnailEligible("image/svg+xml", 1000)).toBe(false);
    expect(thumbnailEligible("application/pdf", 1000)).toBe(false);
    expect(thumbnailEligible("video/mp4", 1000)).toBe(false);
  });

  it("builds an inline Content-Disposition with a safe filename", () => {
    expect(contentDisposition('a"b\\c\r\n.png', "inline")).toBe(`inline; filename="abc.png"; filename*=UTF-8''abc.png`);
    expect(contentDisposition("x.png")).toMatch(/^attachment;/);
  });
});

// ----------------------------------------------------------- ranges ----

describe("range parsing", () => {
  it("ignores missing, foreign-unit and malformed headers", () => {
    for (const h of [null, undefined, "", "items=0-1", "bytes", "bytes=", "bytes=abc", "bytes=-", "bytes=1-2-3", "bytes=5-2"]) {
      expect(parseRange(h, 100), String(h)).toEqual({ kind: "none" });
    }
    expect(parseRange("bytes=0-1234567890123456", 100)).toEqual({ kind: "none" }); // > 15 digits
  });

  it("parses single ranges and clamps the end", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ kind: "range", start: 0, end: 9 });
    expect(parseRange("bytes=10-", 100)).toEqual({ kind: "range", start: 10, end: 99 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRange(" Bytes = 5 - 5 ", 100)).toEqual({ kind: "range", start: 5, end: 5 });
  });

  it("handles suffix ranges", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ kind: "range", start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ kind: "range", start: 0, end: 99 });
    expect(parseRange("bytes=-0", 100)).toEqual({ kind: "unsatisfiable" });
  });

  it("refuses multiple ranges and out-of-bounds starts", () => {
    expect(parseRange("bytes=0-1,5-6", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-1, -5", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=100-", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=100-200", 100)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-0", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-1", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

// ------------------------------------------------------------- text ----

describe("text preview decoding", () => {
  it("caps the text and drops a character cut in half", () => {
    const body = enc.encode("ç".repeat(10)); // 2 bytes each
    const r = decodeTextPreview(body, body.byteLength, 5);
    expect(r).toEqual({ text: "çç", truncated: true });
  });

  it("refuses binary content", () => {
    expect(decodeTextPreview(Uint8Array.from([0x61, 0x00, 0x62]), 3)).toBeNull();
  });
});

// ---------------------------------------------------------- service ----

describe("getFileInline", () => {
  it("serves a real PNG inline with the full header set", async () => {
    const file = await upload(ctxA, "logo.png", "image/png", PNG);
    const r = asBody(await getFileInline(memberA, file.id, {}, storage));
    expect(r.status).toBe(200);
    expect(await readAll(r.body)).toEqual(Buffer.from(PNG));
    expect(r.headers).toMatchObject({
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Length": String(PNG.byteLength),
    });
    expect(r.headers["Content-Disposition"]).toMatch(/^inline; filename="logo\.png"/);
    expect(r.headers["Cache-Control"]).toMatch(/^private\b/);
    const csp = r.headers["Content-Security-Policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp.split(";").map((s) => s.trim())).toContain("sandbox");
    expect(csp).not.toContain("script-src");
    // Images ignore Range (no 206 for non-media).
    expect((await getFileInline(ctxA, file.id, { range: "bytes=0-3" }, storage)).kind).toBe("body");
  });

  it("refuses an HTML file declared as image/png", async () => {
    const file = await upload(ctxA, "evil.png", "image/png", HTML);
    await expect(getFileInline(ctxA, file.id, {}, storage)).rejects.toMatchObject(refused);
    expect((await getFilePreview(ctxA, file.id, storage)).preview).toEqual({ kind: "none" });
  });

  it("refuses SVG and HTML even with matching declared types", async () => {
    const svg = await upload(ctxA, "logo.svg", "image/svg+xml", SVG);
    const html = await upload(ctxA, "page.html", "text/html", HTML);
    for (const f of [svg, html]) {
      await expect(getFileInline(ctxA, f.id, {}, storage)).rejects.toMatchObject(refused);
      expect((await getFilePreview(ctxA, f.id, storage)).preview).toEqual({ kind: "none" });
    }
  });

  it("sends the canonical type for an alias", async () => {
    const file = await upload(ctxA, "foto.jpg", "image/jpg", JPEG);
    expect(asBody(await getFileInline(ctxA, file.id, {}, storage)).headers["Content-Type"]).toBe("image/jpeg");
  });

  it("never serves text types inline (the page renders them itself)", async () => {
    const file = await upload(ctxA, "notlar.txt", "text/plain", enc.encode("merhaba"));
    await expect(getFileInline(ctxA, file.id, {}, storage)).rejects.toMatchObject(refused);
  });

  it("answers single ranges for media with 206 and refuses bad ones", async () => {
    const file = await upload(ctxA, "ses.wav", "audio/wav", WAV);
    const full = asBody(await getFileInline(ctxA, file.id, {}, storage));
    expect(full.status).toBe(200);
    expect(full.headers["Accept-Ranges"]).toBe("bytes");
    expect(full.headers["Content-Security-Policy"]).toContain("media-src 'self'");
    await readAll(full.body);

    const part = asBody(await getFileInline(ctxA, file.id, { range: "bytes=44-53" }, storage));
    expect(part.status).toBe(206);
    expect(part.headers["Content-Range"]).toBe("bytes 44-53/100");
    expect(part.headers["Content-Length"]).toBe("10");
    expect([...(await readAll(part.body))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const suffix = asBody(await getFileInline(ctxA, file.id, { range: "bytes=-3" }, storage));
    expect(suffix.headers["Content-Range"]).toBe("bytes 97-99/100");
    expect([...(await readAll(suffix.body))]).toEqual([53, 54, 55]);

    expect(await getFileInline(ctxA, file.id, { range: "bytes=100-" }, storage)).toEqual({
      kind: "unsatisfiable",
      size: 100,
    });
    expect((await getFileInline(ctxA, file.id, { range: "bytes=0-1,4-5" }, storage)).kind).toBe("unsatisfiable");
    // Malformed: ignored, full body.
    const ignored = asBody(await getFileInline(ctxA, file.id, { range: "bytes=9-2" }, storage));
    expect(ignored.status).toBe(200);
    await readAll(ignored.body);
  });

  it("uses a presigned inline GET with the canonical type on R2", async () => {
    const r2 = createR2Driver({ accountId: "0".repeat(32), accessKeyId: "test", secretAccessKey: "test", bucket: "b" });
    const file = await upload(ctxA, "r2.png", "image/png", PNG);
    // Local bytes for the sniff, R2 for the URL.
    const hybrid: StorageDriver = { ...storage, name: "r2", getDownload: (k, o) => r2.getDownload(k, o) };
    const r = await getFileInline(ctxA, file.id, {}, hybrid);
    if (r.kind !== "redirect") throw new Error("expected redirect");
    const url = new URL(r.url);
    expect(url.searchParams.get("response-content-type")).toBe("image/png");
    expect(url.searchParams.get("response-content-disposition")).toMatch(/^inline;/);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(60);
    // The driver refuses inline for anything off the allow-list.
    const key = generateStorageKey(ctxA.workspaceId, "a.txt");
    await expect(
      r2.getDownload(key, { fileName: "a.txt", contentType: "text/plain", disposition: "inline" }),
    ).rejects.toThrow();
    await expect(
      r2.getDownload(key, { fileName: "a.svg", contentType: "image/svg+xml", disposition: "inline" }),
    ).rejects.toThrow();
  });
});

describe("getFilePreview", () => {
  it("returns metadata, breadcrumbs and the verified kind", async () => {
    const folder = await createFolder(ctxA, { name: "Görseller" });
    const file = await upload(ctxA, "kapak.png", "image/png", PNG, folder.id);
    const r = await getFilePreview(memberA, file.id, storage);
    expect(r.preview).toEqual({ kind: "image" });
    expect(r.breadcrumbs).toEqual([{ id: folder.id, name: "Görseller" }]);
    expect(r.file.uploadedBy.id).toBe(ctxA.userId);
    const pdf = await upload(ctxA, "rapor.pdf", "application/pdf", PDF);
    expect((await getFilePreview(ctxA, pdf.id, storage)).preview).toEqual({ kind: "pdf" });
  });

  it("returns text as plain text, including HTML-looking content", async () => {
    const content = "<script>alert(1)</script>\nİkinci satır: çğıöşü\r\n";
    const file = await upload(ctxA, "not.txt", "text/plain", enc.encode(content));
    expect((await getFilePreview(ctxA, file.id, storage)).preview).toEqual({
      kind: "text",
      text: "<script>alert(1)</script>\nİkinci satır: çğıöşü\n",
      truncated: false,
    });
    const md = await upload(ctxA, "README.md", "", enc.encode("# Başlık"));
    expect((await getFilePreview(ctxA, md.id, storage)).preview).toMatchObject({ kind: "text", text: "# Başlık" });
  });

  it("caps long text", async () => {
    const body = enc.encode("a".repeat(TEXT_PREVIEW_MAX_BYTES + 1000));
    const file = await upload(ctxA, "uzun.csv", "text/csv", body);
    const { preview } = await getFilePreview(ctxA, file.id, storage);
    if (preview.kind !== "text") throw new Error("expected text");
    expect(preview.truncated).toBe(true);
    expect(preview.text.length).toBe(TEXT_PREVIEW_MAX_BYTES);
  });

  it("shows nothing for binary data declared as text", async () => {
    const file = await upload(ctxA, "veri.txt", "text/plain", Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    expect((await getFilePreview(ctxA, file.id, storage)).preview).toEqual({ kind: "none" });
  });
});

describe("tenant isolation", () => {
  it("workspace B cannot inline or preview A's files", async () => {
    const png = await upload(ctxA, "gizli.png", "image/png", PNG);
    const txt = await upload(ctxA, "gizli.txt", "text/plain", enc.encode("gizli"));
    for (const f of [png, txt]) {
      await expect(getFileInline(ctxB, f.id, {}, storage)).rejects.toMatchObject(nf);
      await expect(getFilePreview(ctxB, f.id, storage)).rejects.toMatchObject(nf);
      expect(await authorizeFileAccess(ctxB.userId, f.id)).toBeNull();
    }
    // And the other way round: B's file ids do not resolve in A's ctx.
    const own = await upload(ctxB, "b.png", "image/png", PNG);
    await expect(getFileInline(ctxA, own.id, {}, storage)).rejects.toMatchObject(nf);
    await expect(getFilePreview(memberA, own.id, storage)).rejects.toMatchObject(nf);
    expect(await authorizeFileAccess(ctxA.userId, own.id)).toBeNull();
    expect(await authorizeFileAccess(ctxB.userId, own.id)).toMatchObject({ workspaceId: ctxB.workspaceId });
  });

  it("rejects malformed ids", async () => {
    await expect(getFileInline(ctxA, "", {}, storage)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(getFilePreview(ctxA, "x".repeat(200), storage)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("local driver reads", () => {
  it("readBytes returns at most n bytes, null when missing; ranges are validated", async () => {
    const key = generateStorageKey(ctxA.workspaceId, "k.bin");
    expect(await storage.readBytes(key, 8)).toBeNull();
    await storage.put(key, PNG, { contentType: "image/png", maxBytes: 1000 });
    expect([...(await storage.readBytes(key, 4))!]).toEqual([...PNG.subarray(0, 4)]);
    expect((await storage.readBytes(key, 10_000))!.byteLength).toBe(PNG.byteLength);
    const opts = { fileName: "k.bin", contentType: "image/png" };
    await expect(storage.getDownload(key, { ...opts, range: { start: 5, end: 2 } })).rejects.toThrow();
    await expect(storage.getDownload(key, { ...opts, range: { start: 0, end: PNG.byteLength } })).rejects.toThrow();
    await storage.delete(key);
  });
});

describe("csp per kind", () => {
  it("is sandboxed and minimal for every kind", () => {
    for (const k of ["image", "pdf", "audio", "video"] as const) {
      const csp = inlineCsp(k);
      expect(csp.startsWith("default-src 'none'")).toBe(true);
      expect(csp).toContain("sandbox");
      expect(csp).not.toMatch(/script-src|unsafe-eval|allow-scripts/);
    }
    expect(inlineCsp("pdf")).toContain("frame-ancestors 'self'");
    expect(inlineCsp("image")).toContain("frame-ancestors 'none'");
  });
});
