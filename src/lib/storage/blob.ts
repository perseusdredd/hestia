import {
  BlobNotFoundError,
  del,
  get,
  head,
  issueSignedToken,
  list,
  presignUrl,
  put,
} from "@vercel/blob";

import { isValidStorageKey, isValidWorkspaceSegment } from "./keys";
import { inlineSpec } from "./inline";
import { StorageExistsError, StorageLimitError, type StorageDriver } from "./types";

/** Presigned PUT lifetime (browser upload). Checked when the request starts. */
export const BLOB_UPLOAD_URL_TTL_S = 2 * 60;

/** True when the Blob SDK can authenticate (read-write token, or OIDC + store id). */
export function blobConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.BLOB_READ_WRITE_TOKEN?.trim() || env.BLOB_STORE_ID?.trim());
}

function checkKey(key: string): string {
  if (!isValidStorageKey(key)) throw new Error("Invalid storage key");
  return key;
}

function isAlreadyExists(e: unknown): boolean {
  return e instanceof Error && /already exists/i.test(e.message);
}

async function readAll(stream: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const out = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.byteLength - offset);
    if (take <= 0) break;
    out.set(c.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/**
 * Vercel Blob driver (private store). Browsers upload straight to Blob with a
 * presigned PUT bound to the key, the declared content type and size, and with
 * overwriting disabled (a replayed URL fails with "already exists"). Blob URLs
 * cannot carry our Content-Disposition, CSP or canonical type, so downloads
 * are streamed through the app route after its membership check, exactly like
 * the local driver (including single-range reads for media).
 */
export function createBlobDriver(): StorageDriver {
  if (!blobConfigured()) {
    throw new Error('STORAGE_DRIVER="blob" requires BLOB_READ_WRITE_TOKEN (or BLOB_STORE_ID with Vercel OIDC)');
  }

  return {
    name: "blob",

    async createUploadTarget(key, { contentType, size }) {
      checkKey(key);
      const validUntil = Date.now() + BLOB_UPLOAD_URL_TTL_S * 1000;
      const constraints = { allowedContentTypes: [contentType], maximumSizeInBytes: size };
      const signed = await issueSignedToken({
        pathname: key,
        operations: ["put"],
        validUntil,
        ...constraints,
      });
      const { presignedUrl } = await presignUrl(signed, {
        access: "private",
        operation: "put",
        pathname: key,
        validUntil,
        allowOverwrite: false,
        addRandomSuffix: false,
        ...constraints,
      });
      // Blob infers the stored type from the file extension unless told otherwise;
      // x-content-type makes the declared type authoritative (and is what the
      // allowedContentTypes check compares), so odd extensions still upload.
      return {
        url: presignedUrl,
        method: "PUT",
        headers: { "Content-Type": contentType, "x-content-type": contentType },
      };
    },

    async head(key) {
      try {
        const res = await head(checkKey(key));
        return { size: res.size };
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
    },

    async put(key, body, { contentType, maxBytes }) {
      checkKey(key);
      let payload: Uint8Array | ReadableStream<Uint8Array>;
      let written = 0;
      if (body instanceof Uint8Array) {
        if (body.byteLength > maxBytes) throw new StorageLimitError();
        written = body.byteLength;
        payload = body;
      } else {
        payload = body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              written += chunk.byteLength;
              if (written > maxBytes) controller.error(new StorageLimitError());
              else controller.enqueue(chunk);
            },
          }),
        );
      }
      try {
        await put(key, payload as Parameters<typeof put>[1], {
          access: "private",
          contentType,
          allowOverwrite: false,
          addRandomSuffix: false,
        });
      } catch (e) {
        if (isAlreadyExists(e)) throw new StorageExistsError();
        throw e;
      }
      return { size: written };
    },

    async delete(key) {
      try {
        await del(checkKey(key));
      } catch (e) {
        if (!(e instanceof BlobNotFoundError)) throw e;
      }
    },

    async deleteWorkspaceObjects(workspaceId) {
      if (!isValidWorkspaceSegment(workspaceId)) throw new Error("Invalid workspace id");
      const prefix = `${workspaceId}/`;
      let removed = 0;
      let cursor: string | undefined;
      do {
        const page = await list({ prefix, cursor, limit: 1000 });
        const keys = page.blobs.map((b) => b.pathname).filter((p) => p.startsWith(prefix));
        if (keys.length) {
          await del(keys);
          removed += keys.length;
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
      return removed;
    },

    async readBytes(key, length) {
      checkKey(key);
      const want = Math.max(1, Math.floor(length));
      try {
        const res = await get(key, { access: "private", headers: { Range: `bytes=0-${want - 1}` } });
        if (!res || !res.stream) return null;
        return await readAll(res.stream, want);
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        // An empty object answers a Range request with 416.
        const stat = await head(key).catch(() => null);
        if (stat && stat.size === 0) return new Uint8Array(0);
        throw e;
      }
    },

    async getDownload(key, { contentType, disposition = "attachment", range }) {
      checkKey(key);
      if (disposition === "inline") {
        const spec = inlineSpec(contentType);
        if (!spec || spec.contentType !== contentType) throw new Error("Type is not allowed inline");
      }
      let stat: { size: number };
      try {
        stat = await head(key);
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
      if (range && !(range.start >= 0 && range.start <= range.end && range.end < stat.size)) {
        throw new Error("Invalid byte range");
      }
      const res = await get(key, {
        access: "private",
        useCache: false,
        ...(range ? { headers: { Range: `bytes=${range.start}-${range.end}` } } : {}),
      });
      if (!res || !res.stream) return null;
      return { kind: "stream", stream: res.stream, size: stat.size };
    },
  };
}
