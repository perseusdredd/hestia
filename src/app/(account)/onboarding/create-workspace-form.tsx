"use client";

import { useActionState, useState } from "react";

import { FieldError, FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActionState } from "@/lib/action-state";
import { SLUG_MAX, slugify } from "@/lib/slug";

import { createWorkspaceAction } from "./actions";

export function CreateWorkspaceForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createWorkspaceAction, {});
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);

  // Keep inputs controlled so React's post-action form reset does not clear them.
  return (
    <form action={action} className="grid gap-5" noValidate>
      <FormError message={state.error} />
      <div className="grid gap-2">
        <Label htmlFor="name">Çalışma alanı adı</Label>
        <Input
          id="name"
          name="name"
          required
          maxLength={60}
          placeholder="Örn. Atölye Tasarım"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          aria-invalid={Boolean(state.fieldErrors?.name) || undefined}
        />
        <FieldError errors={state.fieldErrors?.name} />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="slug">Adres</Label>
        <div className="flex items-center rounded-lg border border-input focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 has-aria-invalid:border-destructive dark:bg-input/15">
          <span className="pl-2.5 text-sm text-muted-foreground select-none">/w/</span>
          <Input
            id="slug"
            name="slug"
            required
            maxLength={SLUG_MAX}
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
            }}
            onBlur={() => setSlug((s) => slugify(s))}
            className="border-0 pl-0.5 focus-visible:ring-0 dark:bg-transparent"
            aria-invalid={Boolean(state.fieldErrors?.slug) || undefined}
            aria-describedby="slug-hint"
          />
        </div>
        {state.fieldErrors?.slug ? (
          <FieldError errors={state.fieldErrors.slug} />
        ) : (
          <p id="slug-hint" className="text-xs text-muted-foreground">
            Küçük harf, rakam ve tire. Daha sonra değiştirilemez.
          </p>
        )}
      </div>
      <SubmitButton pending={pending} pendingText="Oluşturuluyor" size="lg">
        Çalışma alanını oluştur
      </SubmitButton>
    </form>
  );
}
