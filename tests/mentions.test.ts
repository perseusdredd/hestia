import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown, transformUrl } from "@/components/markdown";
import {
  formatMentionToken,
  MAX_MENTIONS,
  mentionIdFromHref,
  mentionsForRender,
  mentionsToPlain,
  parseMentionIds,
  sanitizeMentionLabel,
} from "@/lib/mentions";

const render = (text: string, mentions?: Record<string, string>) =>
  renderToStaticMarkup(createElement(Markdown, { text, mentions }));

describe("mention parsing", () => {
  it("finds valid tokens in order, de-duplicated", () => {
    const body = "Merhaba @[Ayşe](user:abc123) ve @[Mehmet](user:def_456), @[Ayşe](user:abc123) tekrar.";
    expect(parseMentionIds(body)).toEqual(["abc123", "def_456"]);
  });

  it("ignores malformed tokens", () => {
    const bad = [
      "@[Ayşe](user:)",
      "@[](user:abc)",
      "@[Ayşe](user:a b)",
      "@[Ayşe](user:abc", // unclosed
      "@[Ayşe](usr:abc)",
      "@[Ayşe](user:" + "x".repeat(65) + ")",
      "@Ayşe",
      "[Ayşe](https://user:abc)",
    ];
    for (const b of bad) expect(parseMentionIds(b), b).toEqual([]);
  });

  it("does not count tokens inside code", () => {
    expect(parseMentionIds("`@[A](user:a1)` and\n```\n@[B](user:b1)\n```\n@[C](user:c1)")).toEqual(["c1"]);
  });

  it("caps the number of mentions", () => {
    const body = Array.from({ length: 50 }, (_, i) => `@[U${i}](user:u${i})`).join(" ");
    const ids = parseMentionIds(body);
    expect(ids).toHaveLength(MAX_MENTIONS);
    expect(ids[0]).toBe("u0");
    expect(parseMentionIds(body, 3)).toEqual(["u0", "u1", "u2"]);
  });

  it("builds tokens that always parse back to the same id", () => {
    const token = formatMentionToken({ id: "ck1", name: "Ali [admin](user:evil) \\ *x*" });
    expect(token).toMatch(/^@\[[^[\]()\\]+\]\(user:ck1\)$/);
    expect(parseMentionIds(token)).toEqual(["ck1"]);
    expect(sanitizeMentionLabel("   ")).toBe("üye");
  });

  it("maps hrefs and plain text", () => {
    expect(mentionIdFromHref("user:abc")).toBe("abc");
    expect(mentionIdFromHref("user:a/b")).toBeNull();
    expect(mentionIdFromHref("https://x.test")).toBeNull();
    expect(mentionsToPlain("Selam @[Takma](user:u1) ve @[Yok](user:u2)", { u1: "Gerçek Ad" })).toBe(
      "Selam @Gerçek Ad ve @Yok",
    );
    expect(mentionsForRender("a @[B](user:b1) `@[C](user:c1)`")).toBe("a [@B](user:b1) `@[C](user:c1)`");
  });
});

describe("mention rendering", () => {
  it("lets user: hrefs through the url transform, nothing else new", () => {
    expect(transformUrl("user:abc")).toBe("user:abc");
    expect(transformUrl("user:abc/../x")).toBe("");
    expect(transformUrl("javascript:alert(1)")).toBe("");
  });

  it("renders a member mention as a non-link chip with the DB name", () => {
    const html = render("Merhaba @[Sahte Ad](user:u1)", { u1: "Ayşe Yılmaz" });
    expect(html).toContain('data-mention="u1"');
    expect(html).toContain("@Ayşe Yılmaz");
    expect(html).not.toContain("Sahte Ad");
    expect(html).not.toMatch(/<a[ >]/);
    expect(html).not.toContain("user:u1");
  });

  it("a spoofed label cannot impersonate another member", () => {
    // The label says "Yönetici" but the id is u2: the chip shows u2's real name.
    const html = render("@[Yönetici](user:u2)", { u1: "Yönetici", u2: "Bora" });
    expect(html).toContain("@Bora");
    expect(html).not.toContain("Yönetici");
  });

  it("a non-member id renders as escaped plain text, never as a link or chip", () => {
    const html = render('@[<img src=x onerror=alert(1)>](user:zz9) and [x](user:zz9 "t")', { u1: "A" });
    expect(html).not.toMatch(/<a[ >]/);
    expect(html).not.toContain("data-mention");
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("&lt;img");
  });

  it("without a names map every mention is plain text", () => {
    const html = render("@[Ayşe](user:u1)");
    expect(html).toContain("@Ayşe");
    expect(html).not.toContain("data-mention");
    expect(html).not.toMatch(/<a[ >]/);
  });

  it("names are escaped by React", () => {
    const html = render("@[x](user:u1)", { u1: '<b onclick="x()">Ali</b>' });
    expect(html).not.toMatch(/<b[ >]/);
    expect(html).toContain("&lt;b");
  });

  it("ordinary links keep working next to mentions", () => {
    const html = render("[site](https://example.com) @[A](user:u1)", { u1: "A" });
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("@A");
  });
});
