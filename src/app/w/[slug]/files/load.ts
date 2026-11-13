import { notFound } from "next/navigation";

import { isServiceError } from "@/server/errors";

/** Run a service read; a NOT_FOUND / VALIDATION ServiceError becomes the 404 page. */
export async function orNotFound<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (e) {
    if (isServiceError(e) && (e.code === "NOT_FOUND" || e.code === "VALIDATION")) notFound();
    throw e;
  }
}
