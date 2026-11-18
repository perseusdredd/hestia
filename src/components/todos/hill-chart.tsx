"use client";

import { History } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { hillHistoryAction, setHillAction } from "@/app/w/[slug]/todos/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HILL_BASE as BASE, HILL_H as H, HILL_W as W, hillPoint } from "@/lib/hill-curve";
import type { HillSnapshotDTO } from "@/server/hill";

const CURVE = Array.from({ length: 41 }, (_, i) => {
  const p = hillPoint(i * 2.5);
  return `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
}).join(" ");

export function hillLabel(position: number): string {
  return position <= 50 ? "Yokuş yukarı: çözülüyor" : "Yokuş aşağı: uygulanıyor";
}

function HillSvg({ position, label }: { position: number; label: string }) {
  const p = hillPoint(position);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      className="h-16 w-full max-w-xs text-muted-foreground"
    >
      <line x1="0" y1={BASE} x2={W} y2={BASE} stroke="currentColor" strokeOpacity="0.3" />
      <line x1={W / 2} y1="4" x2={W / 2} y2={BASE} stroke="currentColor" strokeOpacity="0.3" strokeDasharray="3 3" />
      <path d={CURVE} fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx={p.x} cy={p.y} r="5" className="fill-primary stroke-background" strokeWidth="2" />
    </svg>
  );
}

export function HillChart({
  slug,
  listId,
  listName,
  position,
  note,
}: {
  slug: string;
  listId: string;
  listName: string;
  position: number;
  note: string | null;
}) {
  const [value, setValue] = useState(position);
  const [text, setText] = useState("");
  const [pending, startTransition] = useTransition();
  const [history, setHistory] = useState<HillSnapshotDTO[] | null>(null);

  const changed = value !== position || text.trim() !== "";

  function save() {
    startTransition(async () => {
      const res = await setHillAction(slug, listId, value, text);
      if (res.ok) {
        setText("");
        setHistory(null);
        toast.success(res.message ?? "Güncellendi.");
      } else {
        toast.error(res.error ?? "Konum güncellenemedi.");
      }
    });
  }

  async function loadHistory() {
    const res = await hillHistoryAction(slug, listId);
    if (res.ok) setHistory(res.history);
    else toast.error(res.error);
  }

  return (
    <div className="space-y-2 border-b px-4 py-3">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Tepe grafiği · {hillLabel(value)}</span>
        <span className="tabular-nums">{value}/100</span>
      </div>
      <HillSvg position={value} label={`${listName} tepe konumu: ${value}/100, ${hillLabel(value)}`} />
      {note ? <p className="text-xs text-muted-foreground">Son not: {note}</p> : null}
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        aria-label={`${listName} tepe konumu`}
        className="w-full accent-primary"
      />
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          placeholder="Not (isteğe bağlı)"
          aria-label="Tepe notu"
          autoComplete="off"
        />
        <Button variant="secondary" disabled={!changed || pending} onClick={save}>
          Kaydet
        </Button>
      </div>
      <details onToggle={(e) => (e.currentTarget.open ? void loadHistory() : undefined)}>
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <History className="size-3.5" aria-hidden />
          Geçmiş
        </summary>
        {history === null ? (
          <p className="pt-1 text-xs text-muted-foreground">Yükleniyor…</p>
        ) : history.length === 0 ? (
          <p className="pt-1 text-xs text-muted-foreground">Henüz kayıt yok.</p>
        ) : (
          <ul className="max-h-40 space-y-1 overflow-y-auto pt-1.5 text-xs">
            {history.map((h) => (
              <li key={h.id} className="break-words">
                <span className="font-medium tabular-nums">{h.position}</span>{" "}
                <span className="text-muted-foreground">
                  · {h.createdByName ?? "Bilinmeyen"} · {new Date(h.createdAt).toLocaleDateString("tr-TR")}
                </span>
                {h.note ? <span> · {h.note}</span> : null}
              </li>
            ))}
          </ul>
        )}
      </details>
    </div>
  );
}
