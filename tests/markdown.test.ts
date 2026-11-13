import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown, markdownToPlain, safeUrl, transformUrl } from "@/components/markdown";
import {
  isMarkdownTooDeep,
  MAX_MARKDOWN_NESTING,
  markdownExcerpt,
  markdownNestingDepth,
} from "@/lib/markdown-plain";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("Markdown security", () => {
  it("renders script/iframe/raw HTML as text, not elements", () => {
    const html = render('<script>alert(1)</script>\n\n<iframe src="https://evil.test"></iframe>\n\n<b onclick="x()">hi</b>');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<b[ >]/i);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/<[^>]*onclick=/);
  });

  it("neutralises javascript:, data: and vbscript: links", () => {
    const cases = [
      "[x](javascript:alert(1))",
      "[x](JaVaScRiPt:alert(1))",
      "[x](<  javascript:alert(1)>)",
      "[x](<java\tscript:alert(1)>)",
      "[x](<\u0001javascript:alert(1)>)",
      "[x](data:text/html;base64,AAAA)",
      "[x](vbscript:msgbox(1))",
      "<javascript:alert(1)>",
    ];
    for (const c of cases) {
      const html = render(c);
      expect(html, c).not.toMatch(/href=/i);
      expect(html, c).not.toMatch(/href="\s*javascript/i);
    }
    expect(safeUrl("  JAVASCRIPT:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,x")).toBe("");
  });

  it("adds rel and target to allowed links", () => {
    const html = render("[a](https://example.com) [m](mailto:a@b.co) https://auto.example.org");
    expect(html.match(/rel="noopener noreferrer nofollow"/g)?.length).toBe(3);
    expect(html.match(/target="_blank"/g)?.length).toBe(3);
  });

  it("does not emit img elements", () => {
    const html = render("![pixel](https://tracker.test/p.gif) ![x](javascript:alert(1))");
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('href="https://tracker.test/p.gif"');
  });
});

describe("Markdown rendering", () => {
  it("demotes headings", () => {
    const html = render("# a\n## b\n### c\n#### d");
    expect(html).not.toMatch(/<h1|<h2/);
    expect(html).toMatch(/<h3[^>]*>a/);
    expect(html).toMatch(/<h4[^>]*>b/);
  });

  it("renders gfm tables inside a scroll container", () => {
    const html = render("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(html).toContain("<table");
    expect(html).toMatch(/overflow-x-auto[^>]*><table/);
  });

  it("renders task lists with disabled checkboxes", () => {
    const html = render("- [x] done\n- [ ] todo");
    expect(html.match(/type="checkbox"/g)?.length).toBe(2);
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("handles a 5000 character unbroken string", () => {
    const long = "a".repeat(5000);
    expect(() => render(long)).not.toThrow();
    expect(() => render(`[${long}](https://example.com/${long}) \`${long}\``)).not.toThrow();
  });
});

describe("markdownToPlain", () => {
  it("strips syntax for excerpts", () => {
    expect(markdownToPlain("# Title\n\n**bold** and [link](https://x.y) `code`\n- [ ] task")).toBe(
      "Title bold and link code task",
    );
  });
});

describe("Markdown nesting guard", () => {
  const deep = [
    "- ".repeat(1500) + "x",
    ">".repeat(5000),
    "> ".repeat(2499) + "x",
    Array.from({ length: 400 }, (_, i) => `${"  ".repeat(i)}- x`).join("\n"),
    "1. ".repeat(1200) + "x",
    "> - ".repeat(800) + "x",
  ];

  it("flags pathological nesting and renders it as plain text without throwing", () => {
    for (const text of deep) {
      expect(isMarkdownTooDeep(text), text.slice(0, 20)).toBe(true);
      let html = "";
      expect(() => (html = render(text))).not.toThrow();
      expect(html).toContain("whitespace-pre-wrap");
      expect(html).not.toMatch(/<(ul|ol|blockquote)/);
    }
  });

  it("keeps normal nesting as markdown and the limit itself renders", () => {
    expect(isMarkdownTooDeep("- a\n  - b\n    - c\n> q\n> > qq")).toBe(false);
    expect(markdownNestingDepth("> > - x")).toBe(3);
    const atLimit = "> ".repeat(MAX_MARKDOWN_NESTING) + "x";
    expect(isMarkdownTooDeep(atLimit)).toBe(false);
    expect(render(atLimit).match(/<blockquote/g)?.length).toBe(MAX_MARKDOWN_NESTING);
    expect(() => render("- ".repeat(MAX_MARKDOWN_NESTING) + "x")).not.toThrow();
  });
});

describe("Markdown links and footnotes", () => {
  it("a linked image (badge syntax) renders exactly one anchor", () => {
    const html = render("[![logo](https://a.com/x.png)](https://b.com)");
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).toContain('href="https://b.com"');
    expect(html).toContain(">logo</a>");
    expect(html).not.toMatch(/<img/i);
  });

  it("footnote references and back-links work and are labelled in Turkish", () => {
    const html = render("a[^1]\n\n[^1]: not");
    expect(html).toContain('href="#user-content-fn-1"');
    expect(html).toContain('href="#user-content-fnref-1"');
    expect(html).toContain('id="user-content-fn-1"');
    expect(html).toContain('id="user-content-fnref-1"');
    expect(html).toMatch(/<h4[^>]*class="[^"]*sr-only[^"]*"[^>]*>Dipnotlar</);
    expect(html).not.toContain("Footnotes");
    expect(html).toContain("İçeriğe dön");
    // Same-page anchors never get target/rel.
    expect(html).not.toMatch(/href="#[^"]*"[^>]*target=/);
  });

  it("other fragments and unsafe urls stay blocked", () => {
    expect(transformUrl("#user-content-fn-1")).toBe("#user-content-fn-1");
    expect(transformUrl("#top")).toBe("");
    expect(transformUrl("#user-content-x\"onclick")).toBe("");
    expect(render("[x](#top)")).not.toMatch(/href=/);
  });
});

describe("markdownToPlain / excerpts", () => {
  it("strips line markers anywhere in the body, keeps autolinks and snake_case", () => {
    expect(markdownToPlain("Merhaba\n\n## Gündem\n- [ ] Bütçe\n> alıntı")).toBe("Merhaba Gündem Bütçe alıntı");
    expect(markdownToPlain("Bakın: <https://ornek.com/rapor> ve dosya_adi_v2.pdf")).toBe(
      "Bakın: https://ornek.com/rapor ve dosya_adi_v2.pdf",
    );
    expect(markdownToPlain("**kalın** _eğik_ ~~eski~~ 2*3*4")).toBe("kalın eğik eski 2*3*4");
  });

  it("an excerpt of a body that starts with a long code block is not empty", () => {
    const body = "```js\n" + Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`).join("\n") + "\n```\nAsıl açıklama burada.";
    const excerpt = markdownExcerpt(body);
    expect(excerpt).toBe("Asıl açıklama burada.");
    expect(markdownExcerpt("```\nyalnızca kod\n```")).toBe("(kod bloğu)");
  });

  it("a link whose url runs past the clip point does not leak markdown", () => {
    const body = `Detay: [rapor](https://ornek.com/${"a".repeat(300)}) sonra devamı.`;
    const excerpt = markdownExcerpt(body);
    expect(excerpt).toBe("Detay: rapor sonra devamı.");
    expect(excerpt).not.toContain("](");
    const long = markdownExcerpt("kelime ".repeat(100));
    expect(long.length).toBeLessThanOrEqual(201);
    expect(long.endsWith("…")).toBe(true);
  });
});
