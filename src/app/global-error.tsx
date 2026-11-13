"use client";

/** Last resort for errors thrown by the root layout itself (renders its own <html>). */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="tr">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: 24, textAlign: "center" }}>
        <h1>Bir şeyler ters gitti</h1>
        <p>Beklenmeyen bir hata oluştu.</p>
        <button type="button" onClick={() => reset()}>
          Tekrar dene
        </button>
      </body>
    </html>
  );
}
