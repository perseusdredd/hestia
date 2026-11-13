import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => {
  class BlobNotFoundError extends Error {}
  return {
    BlobNotFoundError,
    del: vi.fn(),
    get: vi.fn(),
    head: vi.fn(),
    issueSignedToken: vi.fn(),
    list: vi.fn(),
    presignUrl: vi.fn(),
    put: vi.fn(),
  };
});
vi.mock("@vercel/blob", () => blob);

import { createBlobDriver } from "@/lib/storage/blob";
import { StorageExistsError, StorageLimitError } from "@/lib/storage/types";

const WS = "cm0000000000000000000000a";
const KEY = `${WS}/abcdefghijklmnopqrstuvwx/file.png`;

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_store_secret";
});

describe("blob storage driver", () => {
  it("refuses to start without credentials", () => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
    expect(() => createBlobDriver()).toThrow(/BLOB_READ_WRITE_TOKEN/);
  });

  it("presigns a private, no-overwrite PUT bound to the key, type and size", async () => {
    blob.issueSignedToken.mockResolvedValue({ delegationToken: "d", clientSigningToken: "c", validUntil: 1 });
    blob.presignUrl.mockResolvedValue({ presignedUrl: "https://vercel.com/api/blob/?pathname=x&sig=1" });
    const target = await createBlobDriver().createUploadTarget(KEY, { contentType: "image/png", size: 123, token: "t" });

    expect(target).toEqual({
      url: "https://vercel.com/api/blob/?pathname=x&sig=1",
      method: "PUT",
      headers: { "Content-Type": "image/png", "x-content-type": "image/png" },
    });
    expect(blob.issueSignedToken.mock.calls[0][0]).toMatchObject({
      pathname: KEY,
      operations: ["put"],
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: 123,
    });
    const presign = blob.presignUrl.mock.calls[0][1];
    expect(presign).toMatchObject({
      access: "private",
      operation: "put",
      pathname: KEY,
      allowOverwrite: false,
      addRandomSuffix: false,
      allowedContentTypes: ["image/png"],
      maximumSizeInBytes: 123,
    });
    expect(presign.validUntil - Date.now()).toBeLessThanOrEqual(2 * 60 * 1000);
  });

  it("rejects keys that are not server-generated", async () => {
    const d = createBlobDriver();
    await expect(d.head("../etc/passwd")).rejects.toThrow(/Invalid storage key/);
    await expect(d.delete("a//b")).rejects.toThrow(/Invalid storage key/);
    await expect(d.deleteWorkspaceObjects("../x")).rejects.toThrow(/Invalid workspace id/);
  });

  it("head returns the size, or null for a missing blob", async () => {
    const d = createBlobDriver();
    blob.head.mockResolvedValueOnce({ size: 42 });
    expect(await d.head(KEY)).toEqual({ size: 42 });
    blob.head.mockRejectedValueOnce(new blob.BlobNotFoundError("nope"));
    expect(await d.head(KEY)).toBeNull();
  });

  it("put never overwrites and enforces the size limit", async () => {
    const d = createBlobDriver();
    blob.put.mockResolvedValueOnce({});
    expect(await d.put(KEY, new Uint8Array(5), { contentType: "image/png", maxBytes: 10 })).toEqual({ size: 5 });
    expect(blob.put.mock.calls[0][2]).toMatchObject({ access: "private", allowOverwrite: false, addRandomSuffix: false });
    await expect(d.put(KEY, new Uint8Array(11), { contentType: "image/png", maxBytes: 10 })).rejects.toBeInstanceOf(
      StorageLimitError,
    );
    blob.put.mockRejectedValueOnce(new Error("This blob already exists, use allowOverwrite"));
    await expect(d.put(KEY, new Uint8Array(1), { contentType: "image/png", maxBytes: 10 })).rejects.toBeInstanceOf(
      StorageExistsError,
    );
  });

  it("delete ignores a missing blob", async () => {
    blob.del.mockRejectedValueOnce(new blob.BlobNotFoundError("gone"));
    await expect(createBlobDriver().delete(KEY)).resolves.toBeUndefined();
  });

  it("deleteWorkspaceObjects pages through the prefix and counts removals", async () => {
    blob.list
      .mockResolvedValueOnce({ blobs: [{ pathname: `${WS}/a/1` }, { pathname: `${WS}/a/2` }], hasMore: true, cursor: "c1" })
      .mockResolvedValueOnce({ blobs: [{ pathname: `${WS}/b/3` }, { pathname: "other/x" }], hasMore: false });
    const removed = await createBlobDriver().deleteWorkspaceObjects(WS);
    expect(removed).toBe(3);
    expect(blob.list.mock.calls[0][0]).toMatchObject({ prefix: `${WS}/` });
    expect(blob.list.mock.calls[1][0]).toMatchObject({ cursor: "c1" });
    expect(blob.del).toHaveBeenCalledWith([`${WS}/a/1`, `${WS}/a/2`]);
    expect(blob.del).toHaveBeenCalledWith([`${WS}/b/3`]);
  });

  it("readBytes asks for a prefix range and returns at most that many bytes", async () => {
    blob.get.mockResolvedValueOnce({ stream: streamOf("0123456789") });
    const bytes = await createBlobDriver().readBytes(KEY, 4);
    expect(new TextDecoder().decode(bytes!)).toBe("0123");
    expect(blob.get.mock.calls[0][1]).toMatchObject({ access: "private", headers: { Range: "bytes=0-3" } });
    blob.get.mockResolvedValueOnce(null);
    expect(await createBlobDriver().readBytes(KEY, 4)).toBeNull();
  });

  it("getDownload streams through the app, with an optional validated range", async () => {
    const d = createBlobDriver();
    blob.head.mockResolvedValue({ size: 10 });
    blob.get.mockResolvedValueOnce({ stream: streamOf("0123456789") });
    const whole = await d.getDownload(KEY, { fileName: "a.png", contentType: "image/png" });
    expect(whole).toMatchObject({ kind: "stream", size: 10 });

    blob.get.mockResolvedValueOnce({ stream: streamOf("234") });
    await d.getDownload(KEY, { fileName: "a.png", contentType: "image/png", range: { start: 2, end: 4 } });
    expect(blob.get.mock.calls[1][1]).toMatchObject({ headers: { Range: "bytes=2-4" } });

    await expect(
      d.getDownload(KEY, { fileName: "a.png", contentType: "image/png", range: { start: 5, end: 99 } }),
    ).rejects.toThrow(/Invalid byte range/);

    blob.head.mockRejectedValueOnce(new blob.BlobNotFoundError("gone"));
    expect(await d.getDownload(KEY, { fileName: "a.png", contentType: "image/png" })).toBeNull();
  });

  it("refuses inline downloads of types that are not allow-listed", async () => {
    await expect(
      createBlobDriver().getDownload(KEY, { fileName: "a.html", contentType: "text/html", disposition: "inline" }),
    ).rejects.toThrow(/not allowed inline/);
  });
});
