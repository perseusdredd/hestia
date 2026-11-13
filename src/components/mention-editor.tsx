"use client";

import { useId, useMemo, useRef, useState } from "react";

import { MarkdownEditor } from "@/components/markdown-editor";
import { displayName, UserAvatar } from "@/components/user-avatar";
import { formatMentionToken } from "@/lib/mentions";
import { cn } from "@/lib/utils";

export type MentionMember = { id: string; name: string; email: string; image: string | null };

type Props = React.ComponentProps<typeof MarkdownEditor> & { members: MentionMember[] };

const MAX_SUGGESTIONS = 8;
// "@" at the start or after whitespace/"(", then up to 30 non-space characters, up to the caret.
const TRIGGER = /(^|[\s(])@([^\s@[\]()]{0,30})$/u;

type Query = { text: string; start: number };

function fold(text: string): string {
  return text
    .toLocaleLowerCase("tr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ı/g, "i");
}

function suggestions(members: MentionMember[], text: string): MentionMember[] {
  const q = fold(text);
  const scored: Array<{ m: MentionMember; score: number }> = [];
  for (const m of members) {
    const name = fold(m.name);
    const email = fold(m.email);
    let score = -1;
    if (!q || name.startsWith(q)) score = 0;
    else if (name.split(/\s+/).some((w) => w.startsWith(q))) score = 1;
    else if (name.includes(q) || email.startsWith(q)) score = 2;
    if (score >= 0) scored.push({ m, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.m.name.localeCompare(b.m.name, "tr"))
    .slice(0, MAX_SUGGESTIONS)
    .map((s) => s.m);
}

/**
 * MarkdownEditor with @mention suggestions. Typing "@" opens a list of
 * workspace members below the editor: arrows move, Enter/Tab picks, Escape
 * closes; on touch, tap a name. The pick is inserted as a stable token
 * (`@[Name](user:<id>)`) that the server validates against the membership.
 */
export function MentionEditor({ members, onKeyDown, onBlur, ...props }: Props) {
  const baseId = useId();
  const listId = `${baseId}-mentions`;
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const [query, setQuery] = useState<Query | null>(null);
  const [active, setActive] = useState(0);
  // Escape closes the list until the caret leaves this "@" (no instant reopen on keyup).
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);

  const matches = useMemo(() => (query ? suggestions(members, query.text) : []), [members, query]);
  const open = matches.length > 0;
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0));

  function detect(el: HTMLTextAreaElement) {
    textarea.current = el;
    const caret = el.selectionStart;
    if (caret !== el.selectionEnd) {
      setQuery(null);
      return;
    }
    const m = TRIGGER.exec(el.value.slice(0, caret));
    if (!m) {
      setQuery(null);
      setDismissedAt(null);
      return;
    }
    const start = caret - m[2].length - 1;
    if (dismissedAt === start) return;
    if (query && query.text === m[2] && query.start === start) return;
    setActive(0);
    setQuery({ text: m[2], start });
  }

  function choose(member: MentionMember) {
    const el = textarea.current;
    if (!el || !query) return;
    el.focus();
    el.setRangeText(`${formatMentionToken(member)} `, query.start, el.selectionStart, "end");
    setQuery(null);
    setDismissedAt(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    textarea.current = e.currentTarget;
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + delta + matches.length) % matches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(matches[activeIndex]);
        return;
      }
      if (e.key === "Escape") {
        // Close the list only (not an enclosing dialog).
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(query?.start ?? null);
        setQuery(null);
        return;
      }
    }
    onKeyDown?.(e);
  }

  function handleKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)) return;
    detect(e.currentTarget);
  }

  const optionId = (i: number) => `${baseId}-opt-${i}`;

  return (
    <div className="grid gap-1.5">
      <MarkdownEditor
        {...props}
        aria-autocomplete="list"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? optionId(activeIndex) : undefined}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onInput={(e) => detect(e.currentTarget)}
        onClick={(e) => detect(e.currentTarget)}
        onBlur={(e) => {
          setQuery(null);
          onBlur?.(e);
        }}
      />
      <p className="sr-only" aria-live="polite">
        {open ? `${matches.length} üye önerisi. Ok tuşlarıyla seçin, Enter ile ekleyin.` : ""}
      </p>
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Bahsedilecek üye"
          className="grid max-h-64 gap-0.5 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {matches.map((m, i) => (
            <li
              key={m.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              // Keep focus (and the caret) in the textarea while picking.
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(m)}
              onPointerEnter={() => setActive(i)}
              className={cn(
                "flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                i === activeIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted",
              )}
            >
              <UserAvatar user={m} size="sm" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate font-medium">{displayName(m)}</span>
              <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:inline">{m.email}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
