import { createBlobDriver } from "./blob";
import { createLocalDriver } from "./local";
import { createR2Driver } from "./r2";
import type { StorageDriver } from "./types";

export * from "./inline";
export * from "./keys";
export * from "./types";
export { createBlobDriver } from "./blob";
export { createLocalDriver } from "./local";
export { createR2Driver } from "./r2";

let cached: { name: string; driver: StorageDriver } | null = null;

/**
 * Storage backend selected by STORAGE_DRIVER ("local" default, "r2" or "blob").
 * The local driver is for development only and refuses to run in production.
 */
export function getStorage(): StorageDriver {
  const name = (process.env.STORAGE_DRIVER || "local").toLowerCase();
  if (cached && cached.name === name) return cached.driver;
  let driver: StorageDriver;
  if (name === "r2") {
    driver = createR2Driver();
  } else if (name === "blob") {
    driver = createBlobDriver();
  } else if (name === "local") {
    if (process.env.NODE_ENV === "production" && process.env.ALLOW_LOCAL_STORAGE !== "true") {
      throw new Error('STORAGE_DRIVER="local" is for development only; use "r2" or "blob" in production');
    }
    driver = createLocalDriver();
  } else {
    throw new Error(`Unknown STORAGE_DRIVER "${name}"`);
  }
  cached = { name, driver };
  return driver;
}

/** Tests only: force a specific driver. */
export function setStorageForTests(driver: StorageDriver | null): void {
  cached = driver ? { name: (process.env.STORAGE_DRIVER || "local").toLowerCase(), driver } : null;
}
