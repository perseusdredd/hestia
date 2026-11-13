export type UploadTarget = {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
};

export type StoredObject = { size: number };

export type DownloadOptions = {
  fileName: string;
  contentType: string;
  /**
   * "attachment" (default) forces a download. "inline" is only valid with an
   * allow-listed `contentType` (see inline.ts); drivers refuse anything else.
   */
  disposition?: "attachment" | "inline";
  /** Local driver: stream only bytes start..end (inclusive, already validated). */
  range?: { start: number; end: number };
};

/**
 * Storage backend. Keys are always produced by generateStorageKey(); drivers
 * still refuse anything that is not a valid key.
 */
export interface StorageDriver {
  readonly name: "local" | "r2" | "blob";
  /**
   * Where the browser sends the bytes. "local" points at our own route
   * handler (carrying the signed upload token); "r2" is a presigned PUT URL.
   */
  createUploadTarget(
    key: string,
    opts: { contentType: string; size: number; token: string },
  ): Promise<UploadTarget>;
  /** Size of the stored object, or null when it does not exist. */
  head(key: string): Promise<StoredObject | null>;
  /** Write bytes (local driver; R2 uploads go straight from the browser). */
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts: { contentType: string; maxBytes: number },
  ): Promise<StoredObject>;
  /** Delete an object. Missing objects are not an error. */
  delete(key: string): Promise<void>;
  /**
   * Delete every object under "<workspaceId>/", including bytes of uploads
   * that were never completed (no DB row points at them). Returns how many
   * objects were removed (local: 1 when the workspace directory existed).
   */
  deleteWorkspaceObjects(workspaceId: string): Promise<number>;
  /**
   * Up to `length` bytes from the start of the object (magic-number sniffing,
   * capped text previews), or null when it does not exist.
   */
  readBytes(key: string, length: number): Promise<Uint8Array | null>;
  /**
   * Local: a byte stream (`size` is the whole object; the stream covers
   * `range` when given). R2: a short-lived presigned GET URL.
   */
  getDownload(
    key: string,
    opts: DownloadOptions,
  ): Promise<
    | { kind: "stream"; stream: ReadableStream<Uint8Array>; size: number }
    | { kind: "redirect"; url: string }
    | null
  >;
}

export class StorageLimitError extends Error {
  constructor() {
    super("Upload exceeds the size limit");
    this.name = "StorageLimitError";
  }
}

/** The key already holds an object; drivers never overwrite on put(). */
export class StorageExistsError extends Error {
  constructor() {
    super("An object already exists at this key");
    this.name = "StorageExistsError";
  }
}
