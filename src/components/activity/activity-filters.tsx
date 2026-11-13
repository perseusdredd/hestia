"use client";

import Form from "next/form";
import Link from "next/link";

import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { displayName } from "@/components/user-avatar";
import { cn } from "@/lib/utils";

import { activityHref } from "./activity-view";

const chipClass =
  "inline-flex h-8 pointer-coarse:h-10 shrink-0 items-center rounded-full border px-3 text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none";

/** Type-group chips (plain links) + member picker (GET form, submits on change). */
export function ActivityFilters({
  slug,
  groups,
  group,
  actorId,
  members,
}: {
  slug: string;
  groups: { key: string; label: string }[];
  group: string | null;
  actorId: string | null;
  members: { id: string; name: string | null; email: string }[];
}) {
  const chip = (key: string | null, label: string) => {
    const active = group === key;
    return (
      <li key={key ?? "all"}>
        <Link
          href={activityHref(slug, key, actorId)}
          aria-current={active ? "page" : undefined}
          className={cn(
            chipClass,
            active
              ? "border-primary/40 bg-primary-soft font-medium text-primary-text"
              : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          {label}
        </Link>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <nav aria-label="Hareket türü" className="min-w-0">
        <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          {chip(null, "Tümü")}
          {groups.map((g) => chip(g.key, g.label))}
        </ul>
      </nav>
      <Form action={`/w/${slug}/activity`} className="flex items-center gap-2">
        {group ? <input type="hidden" name="type" value={group} /> : null}
        <label htmlFor="activity-actor" className="sr-only">
          Üye
        </label>
        <NativeSelect
          id="activity-actor"
          name="actor"
          defaultValue={actorId ?? ""}
          className="w-full sm:w-56"
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
        >
          <option value="">Tüm üyeler</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {displayName(m)}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit" variant="outline">
          Uygula
        </Button>
      </Form>
    </div>
  );
}
