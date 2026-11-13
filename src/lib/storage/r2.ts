import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { contentDisposition, downloadContentType, isValidStorageKey, isValidWorkspaceSegment } from "./keys";
import { inlineSpec } from "./inline";
import type { StorageDriver } from "./types";

/** Presigned PUT lifetime (browser upload). Checked when the request starts. */
export const UPLOAD_URL_TTL_S = 2 * 60;
/** Presigned GET lifetime (download redirect). */
const DOWNLOAD_URL_TTL_S = 60;

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
};

export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config {
  const cfg = {
    accountId: env.R2_ACCOUNT_ID ?? "",
    accessKeyId: env.R2_ACCESS_KEY_ID ?? "",
    secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? "",
    bucket: env.R2_BUCKET ?? "",
  };
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`R2 storage is not configured: STORAGE_DRIVER="r2" requires ${missing.join(", ")}`);
  if (!/^[a-f0-9]{32}$/i.test(cfg.accountId)) throw new Error("R2_ACCOUNT_ID must be the 32-character hex Cloudflare account id");
  return cfg;
}

function checkKey(key: string): string {
  if (!isValidStorageKey(key)) throw new Error("Invalid storage key");
  return key;
}

function isNotFound(e: unknown): boolean {
  return (
    e instanceof S3ServiceException &&
    (e.name === "NotFound" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404)
  );
}

/**
 * Cloudflare R2 driver. Browsers upload straight to R2 with a presigned PUT
 * (Vercel caps request bodies at 4.5 MB) and download through a short-lived
 * presigned GET that forces `attachment`. Inline previews of allow-listed
 * images/audio/video/PDF use the same presigned GET with an `inline`
 * disposition and the canonical type; R2 responses cannot carry our CSP,
 * so text is never served inline from R2. The bucket must stay private.
 */
export function createR2Driver(cfg: R2Config = r2ConfigFromEnv()): StorageDriver {
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${cfg.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });

  return {
    name: "r2",

    async createUploadTarget(key, { contentType, size }) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: cfg.bucket,
          Key: checkKey(key),
          ContentType: contentType,
          ContentLength: size,
          // Conditional PUT: R2 refuses a second write to an existing key, so
          // the URL cannot be replayed to swap the bytes behind a File row.
          IfNoneMatch: "*",
        }),
        {
          expiresIn: UPLOAD_URL_TTL_S,
          // Bind the declared type, size and the no-overwrite condition into the signature.
          signableHeaders: new Set(["content-type", "content-length", "if-none-match"]),
        },
      );
      return { url, method: "PUT", headers: { "Content-Type": contentType, "If-None-Match": "*" } };
    },

    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: checkKey(key) }));
        return { size: res.ContentLength ?? 0 };
      } catch (e) {
        if (isNotFound(e)) return null;
        throw e;
      }
    },

    async put(key, body, { contentType, maxBytes }) {
      // Server-side writes are not used with R2 (uploads go browser -> R2),
      // but support small buffers for completeness.
      if (!(body instanceof Uint8Array)) throw new Error("R2 driver only accepts buffers");
      if (body.byteLength > maxBytes) throw new Error("Upload exceeds the size limit");
      await client.send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: checkKey(key), Body: body, ContentType: contentType }),
      );
      return { size: body.byteLength };
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: checkKey(key) }));
    },

    async deleteWorkspaceObjects(workspaceId) {
      if (!isValidWorkspaceSegment(workspaceId)) throw new Error("Invalid workspace id");
      const prefix = `${workspaceId}/`;
      let removed = 0;
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: token, MaxKeys: 1000 }),
        );
        const keys = (page.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k?.startsWith(prefix)));
        if (keys.length) {
          const res = await client.send(
            new DeleteObjectsCommand({
              Bucket: cfg.bucket,
              Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          if (res.Errors?.length) {
            throw new Error(`R2 could not delete ${res.Errors.length} object(s) under ${prefix}`);
          }
          removed += keys.length;
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return removed;
    },

    async readBytes(key, length) {
      const want = Math.max(1, Math.floor(length));
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket: cfg.bucket, Key: checkKey(key), Range: `bytes=0-${want - 1}` }),
        );
        if (!res.Body) return new Uint8Array(0);
        const bytes = await res.Body.transformToByteArray();
        return bytes.subarray(0, want);
      } catch (e) {
        if (isNotFound(e)) return null;
        // Empty objects answer a Range request with 416 InvalidRange.
        if (e instanceof S3ServiceException && e.$metadata?.httpStatusCode === 416) return new Uint8Array(0);
        throw e;
      }
    },

    async getDownload(key, { fileName, contentType, disposition = "attachment" }) {
      // R2 cannot attach our CSP/CORP headers, so inline is limited to the
      // allow-listed binary types (images, audio, video, PDF; never text) and
      // always uses the canonical type, overriding whatever R2 stored.
      let type: string;
      if (disposition === "inline") {
        const spec = inlineSpec(contentType);
        if (!spec || spec.contentType !== contentType) throw new Error("Type is not allowed inline");
        type = spec.contentType;
      } else {
        type = downloadContentType(contentType);
      }
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: cfg.bucket,
          Key: checkKey(key),
          ResponseContentDisposition: contentDisposition(fileName, disposition),
          ResponseContentType: type,
          ResponseCacheControl: "private, no-store",
        }),
        { expiresIn: DOWNLOAD_URL_TTL_S },
      );
      return { kind: "redirect", url };
    },
  };
}
