import { z } from "zod";

export type ServiceErrorCode = "NOT_FOUND" | "FORBIDDEN" | "VALIDATION" | "CONFLICT";

/**
 * Error thrown by service functions. `message` is user-facing (Turkish) and
 * safe to show in the UI. Server actions convert it with toActionState().
 */
export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly fieldErrors?: Record<string, string[] | undefined>;

  constructor(
    code: ServiceErrorCode,
    message: string,
    fieldErrors?: Record<string, string[] | undefined>,
  ) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function isServiceError(e: unknown): e is ServiceError {
  return e instanceof ServiceError;
}

export const notFound = (message = "Kayıt bulunamadı.") =>
  new ServiceError("NOT_FOUND", message);
export const forbidden = (message = "Bu işlem için yetkiniz yok.") =>
  new ServiceError("FORBIDDEN", message);
export const conflict = (message: string) => new ServiceError("CONFLICT", message);

/** Validate input with zod; throws ServiceError("VALIDATION") with field errors. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const flat = z.flattenError(result.error);
    const first =
      flat.formErrors[0] ??
      Object.values(flat.fieldErrors as Record<string, string[] | undefined>).find(
        (v) => v && v.length,
      )?.[0] ??
      "Geçersiz bilgi.";
    throw new ServiceError(
      "VALIDATION",
      first,
      flat.fieldErrors as Record<string, string[] | undefined>,
    );
  }
  return result.data;
}
