import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, open, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { isValidStorageKey, isValidWorkspaceSegment } from "./keys";
import { StorageExistsError, StorageLimitError, type StorageDriver } from "./types";

/**
 * Development-only driver: files live under `root` (default ./.storage).
 * Uploads go through PUT /api/files/upload?token=..., downloads are streamed
 * by GET /api/files/[fileId] after the membership check.
 */
export function createLocalDriver(root = process.env.LOCAL_STORAGE_DIR || ".storage"): StorageDriver {
  const base = path.resolve(root);

  /** Absolute path for a key; throws for anything that escapes `base`. */
  function resolveKey(key: string): string {
    if (!isValidStorageKey(key)) throw new Error("Invalid storage key");
    const full = path.resolve(base, ...key.split("/"));
    const rel = path.relative(base, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("Storage key resolves outside the storage root");
    }
    return full;
  }

  return {
    name: "local",

    async createUploadTarget(_key, { contentType, token }) {
      resolveKey(_key);
      return {
        url: `/api/files/upload?token=${encodeURIComponent(token)}`,
        method: "PUT",
        headers: { "Content-Type": contentType },
      };
    },

    async head(key) {
      try {
        const s = await stat(resolveKey(key));
        return s.isFile() ? { size: s.size } : null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },

    async put(key, body, { maxBytes }) {
      const target = resolveKey(key);
      await mkdir(path.dirname(target), { recursive: true });
      // Unique per call: two writes in the same millisecond must not share
      // (and then delete) each other's temp file.
      const tmp = `${target}.part-${randomUUID()}`;
      let written = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          written += chunk.length;
          if (written > maxBytes) cb(new StorageLimitError());
          else cb(null, chunk);
        },
      });
      const source =
        body instanceof Uint8Array
          ? Readable.from([Buffer.from(body)])
          : Readable.fromWeb(body as import("node:stream/web").ReadableStream<Uint8Array>);
      try {
        await pipeline(source, limiter, createWriteStream(tmp, { flags: "wx" }));
        // link() never overwrites (unlike rename): a second write to the same
        // key, e.g. a concurrent replay of one upload token, fails with EEXIST.
        await link(tmp, target);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new StorageExistsError();
        throw e;
      } finally {
        await rm(tmp, { force: true });
      }
      return { size: written };
    },

    async delete(key) {
      const target = resolveKey(key);
      await rm(target, { force: true });
      // Remove the now-empty "<random id>" directory; ignore if not empty.
      await rmdir(path.dirname(target)).catch(() => {});
    },

    async deleteWorkspaceObjects(workspaceId) {
      if (!isValidWorkspaceSegment(workspaceId)) throw new Error("Invalid workspace id");
      const dir = path.resolve(base, workspaceId);
      const rel = path.relative(base, dir);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
        throw new Error("Workspace directory resolves outside the storage root");
      }
      const existed = await stat(dir).then(
        (s) => s.isDirectory(),
        () => false,
      );
      await rm(dir, { recursive: true, force: true });
      return existed ? 1 : 0;
    },

    async readBytes(key, length) {
      const target = resolveKey(key);
      const want = Math.max(0, Math.floor(length));
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(target, "r");
        const s = await handle.stat();
        if (!s.isFile()) return null;
        const buf = Buffer.alloc(Math.min(want, s.size));
        let read = 0;
        while (read < buf.length) {
          const { bytesRead } = await handle.read(buf, read, buf.length - read, read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return new Uint8Array(buf.buffer, buf.byteOffset, read);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EISDIR") return null;
        throw e;
      } finally {
        await handle?.close();
      }
    },

    async getDownload(key, opts) {
      const target = resolveKey(key);
      try {
        const s = await stat(target);
        if (!s.isFile()) return null;
        const range = opts?.range;
        if (range && !(range.start >= 0 && range.start <= range.end && range.end < s.size)) {
          throw new Error("Invalid byte range");
        }
        const stream = Readable.toWeb(
          createReadStream(target, range ? { start: range.start, end: range.end } : undefined),
        ) as ReadableStream<Uint8Array>;
        return { kind: "stream", stream, size: s.size };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw e;
      }
    },
  };
}
