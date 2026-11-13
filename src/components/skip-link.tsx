/** Id of the page's one <main>; the skip link and route-change focus target it. */
export const MAIN_ID = "main-content";

/**
 * "İçeriğe geç": the first tab stop on every page. Hidden until focused, then
 * jumps past the header and navigation to <main id={MAIN_ID} tabIndex={-1}>.
 */
export function SkipLink() {
  return (
    <a
      href={`#${MAIN_ID}`}
      className="sr-only rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-md outline-none focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      İçeriğe geç
    </a>
  );
}
