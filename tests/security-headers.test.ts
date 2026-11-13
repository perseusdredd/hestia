import { describe, expect, it } from "vitest";

import {
  buildContentSecurityPolicy,
  type CspOptions,
  isTokenPath,
  needsPageCsp,
  staticSecurityHeaders,
} from "@/lib/security-headers";

const base: CspOptions = { nonce: "abc123==", isDev: false, pusherCluster: null, r2: null, googleAuth: false };
const ACCOUNT = "0123456789abcdef0123456789abcdef";

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values] as const;
    }),
  );
}

describe("buildContentSecurityPolicy", () => {
  it("production policy: nonce + strict-dynamic, no inline/eval scripts, locked-down framing", () => {
    const d = directives(buildContentSecurityPolicy(base));
    expect(d.get("script-src")).toEqual(["'self'", "'nonce-abc123=='", "'strict-dynamic'"]);
    expect(d.get("object-src")).toEqual(["'none'"]);
    expect(d.get("frame-ancestors")).toEqual(["'none'"]);
    expect(d.get("base-uri")).toEqual(["'self'"]);
    expect(d.get("form-action")).toEqual(["'self'"]);
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(d.get("connect-src")).toEqual(["'self'"]);
    expect(d.get("default-src")).toEqual(["'self'"]);
  });

  it("development adds only what HMR needs", () => {
    const d = directives(buildContentSecurityPolicy({ ...base, isDev: true }));
    expect(d.get("script-src")).toContain("'unsafe-eval'");
    expect(d.get("script-src")).not.toContain("'unsafe-inline'");
    expect(d.get("connect-src")).toEqual(expect.arrayContaining(["ws:", "wss:"]));
  });

  it("adds the Pusher endpoints for the configured cluster only", () => {
    const d = directives(buildContentSecurityPolicy({ ...base, pusherCluster: "eu" }));
    expect(d.get("connect-src")).toEqual(["'self'", "wss://ws-eu.pusher.com", "https://sockjs-eu.pusher.com"]);
    const bad = directives(buildContentSecurityPolicy({ ...base, pusherCluster: "eu; script-src *" }));
    expect(bad.get("connect-src")).toEqual(["'self'"]);
  });

  it("adds the R2 hosts to connect-src and img-src only when configured", () => {
    const d = directives(buildContentSecurityPolicy({ ...base, r2: { accountId: ACCOUNT, bucket: "hestia-files" } }));
    const hosts = [`https://${ACCOUNT}.r2.cloudflarestorage.com`, `https://hestia-files.${ACCOUNT}.r2.cloudflarestorage.com`];
    expect(d.get("connect-src")).toEqual(["'self'", ...hosts]);
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:", ...hosts]);
    const invalid = directives(buildContentSecurityPolicy({ ...base, r2: { accountId: "not-an-id", bucket: "x" } }));
    expect(invalid.get("connect-src")).toEqual(["'self'"]);
  });

  it("allows uploads to the Vercel Blob API in connect-src only when the blob driver is on", () => {
    const on = directives(buildContentSecurityPolicy({ ...base, blob: true }));
    expect(on.get("connect-src")).toEqual(["'self'", "https://vercel.com"]);
    const off = directives(buildContentSecurityPolicy(base));
    expect(off.get("connect-src")).toEqual(["'self'"]);
  });

  it("allows the Google OAuth redirect in form-action when the provider is enabled", () => {
    const d = directives(buildContentSecurityPolicy({ ...base, googleAuth: true }));
    expect(d.get("form-action")).toEqual(["'self'", "https://accounts.google.com"]);
    expect(d.get("img-src")).toContain("https://lh3.googleusercontent.com");
  });

  it("rejects a nonce that could break out of the header", () => {
    expect(() => buildContentSecurityPolicy({ ...base, nonce: "x' 'unsafe-inline" })).toThrow();
  });
});

describe("staticSecurityHeaders", () => {
  it("sets the baseline headers and HSTS only in production", () => {
    const prod = staticSecurityHeaders({ pathname: "/app", isProduction: true });
    expect(prod["X-Content-Type-Options"]).toBe("nosniff");
    expect(prod["X-Frame-Options"]).toBe("DENY");
    expect(prod["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(prod["Permissions-Policy"]).toContain("camera=()");
    expect(prod["Permissions-Policy"]).toContain("microphone=()");
    expect(prod["Permissions-Policy"]).toContain("geolocation=()");
    expect(prod["Strict-Transport-Security"]).toMatch(/^max-age=\d+/);
    expect(staticSecurityHeaders({ pathname: "/app", isProduction: false })["Strict-Transport-Security"]).toBeUndefined();
  });

  it("token pages and API routes never send a referrer", () => {
    for (const p of ["/reset-password/tok", "/verify-email/tok", "/invite/tok", "/api/files/abc"]) {
      expect(staticSecurityHeaders({ pathname: p, isProduction: true })["Referrer-Policy"]).toBe("no-referrer");
    }
    expect(isTokenPath("/invites")).toBe(false);
    expect(isTokenPath("/w/x/settings")).toBe(false);
  });

  it("leaves the CSP of API routes to the handlers", () => {
    expect(needsPageCsp("/api/files/abc")).toBe(false);
    expect(needsPageCsp("/w/demo/files")).toBe(true);
  });
});
