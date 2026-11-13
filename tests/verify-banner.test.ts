import { describe, expect, it } from "vitest";

import { hidesVerifyBanner, isVerifyBannerDismissed } from "@/lib/verify-banner";

describe("verify-email banner", () => {
  it("the dismissal cookie only hides the banner for the address it was set for", () => {
    expect(isVerifyBannerDismissed(undefined, "a@x.test")).toBe(false);
    expect(isVerifyBannerDismissed("", "a@x.test")).toBe(false);
    expect(isVerifyBannerDismissed(encodeURIComponent("A@X.test"), " a@x.test ")).toBe(true);
    expect(isVerifyBannerDismissed(encodeURIComponent("b@x.test"), "a@x.test")).toBe(false);
    expect(isVerifyBannerDismissed("%E0%A4%A", "a@x.test")).toBe(false);
  });

  it("is not shown on the chat route (it would push the composer below the fold)", () => {
    expect(hidesVerifyBanner("/w/acme/chat")).toBe(true);
    expect(hidesVerifyBanner("/w/acme/chat/")).toBe(true);
    expect(hidesVerifyBanner("/w/acme")).toBe(false);
    expect(hidesVerifyBanner("/w/acme/chatter")).toBe(false);
    expect(hidesVerifyBanner("/w/acme/messages")).toBe(false);
    expect(hidesVerifyBanner(null)).toBe(false);
  });
});
