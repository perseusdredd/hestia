import { Prisma } from "@prisma/client";
import { z } from "zod";

import { isServiceError } from "@/server/errors";

/**
 * Standard return shape for server actions used with useActionState.
 * `fieldErrors` keys match form field names.
 */
export type ActionState<T = undefined> = {
  ok?: boolean;
  error?: string;
  message?: string;
  fieldErrors?: Record<string, string[] | undefined>;
  /** Submitted (non-secret) values, to refill inputs after React resets the form. */
  values?: Record<string, string>;
  data?: T;
};

export const initialActionState: ActionState = {};

/**
 * Convert a thrown error into an ActionState. Re-throws anything that is not a
 * known, user-safe error (e.g. Next.js redirect/notFound errors must propagate).
 */
export function toActionState<T = undefined>(e: unknown): ActionState<T> {
  if (isServiceError(e)) {
    return { ok: false, error: e.message, fieldErrors: e.fieldErrors };
  }
  if (e instanceof z.ZodError) {
    const flat = z.flattenError(e);
    return {
      ok: false,
      error: flat.formErrors[0] ?? "Lütfen formdaki hataları düzeltin.",
      fieldErrors: flat.fieldErrors as Record<string, string[] | undefined>,
    };
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    return { ok: false, error: "Bu kayıt zaten mevcut." };
  }
  throw e;
}

/** Read a FormData field as a string (empty string when missing or a File). */
export function formString(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

/** Read a checkbox: true when the field was submitted (checked), false when missing. */
export function formFlag(formData: FormData, key: string): boolean {
  return formData.has(key);
}
