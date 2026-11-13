/** Shown while a workspace page streams in; the shell (sidebar, header) stays put. */
export default function WorkspaceLoading() {
  return (
    <div role="status" aria-live="polite" className="grid gap-4 p-4 md:p-6">
      <span className="sr-only">Yükleniyor…</span>
      <div aria-hidden className="h-8 w-48 rounded-lg bg-muted motion-safe:animate-pulse" />
      <div aria-hidden className="grid gap-3 md:grid-cols-2">
        <div className="h-32 rounded-xl bg-muted motion-safe:animate-pulse" />
        <div className="h-32 rounded-xl bg-muted motion-safe:animate-pulse" />
      </div>
      <div aria-hidden className="h-48 rounded-xl bg-muted motion-safe:animate-pulse" />
    </div>
  );
}
