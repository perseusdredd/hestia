// Shared by the verify-email banner (client) and the layouts (server).

/** Session cookie set when the user dismisses the verify-email banner. */
export const VERIFY_BANNER_COOKIE = "hestia_verify_dismissed";

/** True when the dismissal cookie belongs to this address (a new account shows it again). */
export function isVerifyBannerDismissed(cookieValue: string | null | undefined, email: string): boolean {
  if (!cookieValue) return false;
  let value = cookieValue;
  try {
    value = decodeURIComponent(cookieValue);
  } catch {
    // malformed: compare as is
  }
  return value.trim().toLowerCase() === email.trim().toLowerCase();
}

/**
 * The chat room sizes itself to the viewport, so a banner above it pushes the
 * composer below the fold. The banner is not shown there.
 */
export function hidesVerifyBanner(pathname: string | null): boolean {
  return Boolean(pathname && /^\/w\/[^/]+\/chat(?:\/|$)/.test(pathname));
}
