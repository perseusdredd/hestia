"use client";

import { AlertCircle, Loader2, RotateCw, Trash2, X } from "lucide-react";
import { memo } from "react";

import { timeLabel, type FeedItem, type FeedRow } from "@/components/chat/chat-utils";
import { LinkifiedText } from "@/components/linkified-text";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Handlers = {
  canDelete: (item: FeedItem) => boolean;
  onDelete: (item: FeedItem) => void;
  onRetry: (clientId: string) => void;
  onDiscard: (clientId: string) => void;
};

export function MessageFeed({ rows, ...handlers }: { rows: FeedRow[] } & Handlers) {
  return (
    <ol className="space-y-1" aria-label="Mesajlar">
      {rows.map((row) =>
        row.type === "day" ? (
          <li key={row.key} className="flex items-center gap-3 py-3" aria-label={row.label}>
            <span className="h-px flex-1 bg-border" aria-hidden />
            <span className="rounded-full border bg-background px-2.5 py-0.5 text-xs font-medium text-muted-foreground">{row.label}</span>
            <span className="h-px flex-1 bg-border" aria-hidden />
          </li>
        ) : (
          <li key={row.key} className="flex gap-3 py-2">
            <UserAvatar user={row.author} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-semibold">{displayName(row.author)}</span>
                <time
                  className="shrink-0 text-xs text-muted-foreground tabular-nums"
                  dateTime={row.items[0].createdAt.toISOString()}
                  title={formatDateTime(row.items[0].createdAt)}
                >
                  {timeLabel(row.items[0].createdAt)}
                </time>
              </div>
              <div className="mt-0.5 space-y-0.5">
                {row.items.map((item) => (
                  <MessageLine key={item.key} item={item} {...handlers} />
                ))}
              </div>
            </div>
          </li>
        ),
      )}
    </ol>
  );
}

type LineProps = { item: FeedItem } & Handlers;

/**
 * The feed rebuilds every FeedItem object when a message arrives, so lines
 * compare by content: one incoming message renders one new line instead of
 * re-rendering (and re-linkifying) every message on screen.
 */
function sameLine(a: LineProps, b: LineProps): boolean {
  const x = a.item;
  const y = b.item;
  return (
    x.key === y.key &&
    x.id === y.id &&
    x.body === y.body &&
    x.status === y.status &&
    x.error === y.error &&
    x.clientId === y.clientId &&
    x.author.id === y.author.id &&
    x.createdAt.getTime() === y.createdAt.getTime() &&
    a.canDelete === b.canDelete &&
    a.onDelete === b.onDelete &&
    a.onRetry === b.onRetry &&
    a.onDiscard === b.onDiscard
  );
}

const MessageLine = memo(function MessageLine({ item, canDelete, onDelete, onRetry, onDiscard }: LineProps) {
  const deletable = item.status === "sent" && canDelete(item);
  return (
    <div
      className={cn(
        "group/line relative -mx-2 rounded-md px-2 py-0.5 hover:bg-accent/60",
        deletable && "pr-9 pointer-coarse:pr-12",
      )}
    >
      <p
        className={cn(
          "text-sm leading-relaxed break-words whitespace-pre-wrap",
          item.status === "sending" && "text-muted-foreground",
        )}
        title={formatDateTime(item.createdAt)}
      >
        <LinkifiedText text={item.body} />
      </p>

      {item.status === "sending" ? (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden />
          Gönderiliyor…
        </p>
      ) : null}

      {item.status === "failed" && item.clientId ? (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span role="alert" className="flex items-center gap-1 text-destructive">
            <AlertCircle className="size-3.5" aria-hidden />
            {item.error ?? "Gönderilemedi."}
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={() => onRetry(item.clientId!)}>
            <RotateCw aria-hidden />
            Tekrar dene
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => onDiscard(item.clientId!)}>
            <X aria-hidden />
            Vazgeç
          </Button>
        </div>
      ) : null}

      {deletable ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Mesajı sil"
          title="Mesajı sil"
          onClick={() => onDelete(item)}
          className="absolute top-1 right-1 text-muted-foreground hover:text-destructive focus-visible:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/line:opacity-100"
        >
          <Trash2 aria-hidden />
        </Button>
      ) : null}
    </div>
  );
}, sameLine);
