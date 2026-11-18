import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import {
  contentDisposition,
  createLocalDriver,
  createR2Driver,
  downloadContentType,
  generateStorageKey,
  isValidStorageKey,
  MAX_FILE_SIZE,
  sanitizeKeySegment,
  StorageExistsError,
  StorageLimitError,
  type StorageDriver,
} from "@/lib/storage";
import { signUploadToken } from "@/lib/storage/upload-token";
import type { TenantContext } from "@/lib/tenant-context";
import {
  acceptLocalUpload,
  authorizeFileAccess,
  completeUpload,
  createDocument,
  createFolder,
  createPendingUpload,
  deleteDocument,
  deleteFile,
  deleteFolder,
  getDocument,
  getFileDownload,
  getFolderPath,
  listFolderContents,
  listFolderTree,
  moveDocument,
  moveFile,
  moveFolder,
  renameFile,
  renameFolder,
  updateDocument,
} from "@/server/files";

import { purgeTrashItem, restoreTrashItem } from "@/server/trash";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect } from "./helpers";

let root: string;
let storage: StorageDriver;

let ctxA: TenantContext;
let ctxB: TenantContext;
let memberA: TenantContext;
let member2A: TenantContext;
let adminA: TenantContext;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Full local upload flow: pending -> PUT (service) -> complete. */
async function upload(ctx: TenantContext, name: string, content: string, folderId: string | null = null) {
  const bytes = new TextEncoder().encode(content);
  const pending = await createPendingUpload(ctx, { name, size: bytes.byteLength, type: "text/plain", folderId }, storage);
  const put = await acceptLocalUpload(ctx.userId, pending.token, bytes, bytes.byteLength, storage);
  expect(put).toEqual({ ok: true, size: bytes.byteLength });
  const file = await completeUpload(ctx, pending.token, storage);
  return { file, token: pending.token };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hestia-files-"));
  storage = createLocalDriver(root);

  const ownerA = await createTestUser();
  const ownerB = await createTestUser();
  ({ ctx: ctxA } = await createTestWorkspace(ownerA.id));
  ({ ctx: ctxB } = await createTestWorkspace(ownerB.id));
  ({ ctx: memberA } = await createMember(ctxA.workspaceId, "MEMBER"));
  ({ ctx: member2A } = await createMember(ctxA.workspaceId, "MEMBER"));
  ({ ctx: adminA } = await createMember(ctxA.workspaceId, "ADMIN"));
});

afterAll(async () => {
  await cleanup();
  await disconnect();
  await rm(root, { recursive: true, force: true });
});

describe("storage keys", () => {
  it("generates <workspaceId>/<random>/<sanitised name> keys", () => {
    const key = generateStorageKey(ctxA.workspaceId, "../../etc/Şirket Raporu (son).pdf");
    const [ws, id, name] = key.split("/");
    expect(ws).toBe(ctxA.workspaceId);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(name).toBe("Sirket-Raporu-son-.pdf");
    expect(isValidStorageKey(key)).toBe(true);
    expect(generateStorageKey(ctxA.workspaceId, "a.txt")).not.toBe(generateStorageKey(ctxA.workspaceId, "a.txt"));
  });

  it("sanitises hostile names", () => {
    expect(sanitizeKeySegment("..\\..\\windows\\system32")).toBe("system32");
    expect(sanitizeKeySegment("....")).toBe("dosya");
    expect(sanitizeKeySegment("")).toBe("dosya");
    expect(sanitizeKeySegment("x".repeat(300) + ".txt").length).toBeLessThanOrEqual(100);
  });

  it("refuses traversal-shaped keys and workspace ids", () => {
    for (const bad of ["../a/b", "a/../b", "a/b/..", "a/b", "a/b/c/d", "/a/b/c", "a//b", "a/b/c\\..\\d", ""]) {
      expect(isValidStorageKey(bad), bad).toBe(false);
    }
    expect(() => generateStorageKey("../evil", "a.txt")).toThrow();
    expect(() => generateStorageKey("a/b", "a.txt")).toThrow();
  });

  it("serves downloads as attachments with a safe filename and no active types", () => {
    expect(contentDisposition('kötü"\r\nname.html')).toMatch(/^attachment; filename="kotuname.html"; filename\*=UTF-8''/);
    expect(downloadContentType("text/html")).toBe("application/octet-stream");
    expect(downloadContentType("image/svg+xml")).toBe("application/octet-stream");
    expect(downloadContentType("application/pdf")).toBe("application/pdf");
  });
});

describe("local driver", () => {
  it("round-trips put / head / download / delete", async () => {
    const key = generateStorageKey(ctxA.workspaceId, "notlar.txt");
    const body = new TextEncoder().encode("merhaba dünya");
    expect(await storage.head(key)).toBeNull();
    const { size } = await storage.put(key, body, { contentType: "text/plain", maxBytes: 1000 });
    expect(size).toBe(body.byteLength);
    expect(await storage.head(key)).toEqual({ size: body.byteLength });
    const dl = await storage.getDownload(key, { fileName: "notlar.txt", contentType: "text/plain" });
    expect(dl?.kind).toBe("stream");
    if (dl?.kind !== "stream") throw new Error("expected stream");
    expect((await readAll(dl.stream)).toString("utf8")).toBe("merhaba dünya");
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    expect(await storage.getDownload(key, { fileName: "x", contentType: "text/plain" })).toBeNull();
  });

  it("enforces maxBytes and leaves nothing behind", async () => {
    const key = generateStorageKey(ctxA.workspaceId, "big.bin");
    await expect(storage.put(key, new Uint8Array(11), { contentType: "x/y", maxBytes: 10 })).rejects.toBeInstanceOf(
      StorageLimitError,
    );
    expect(await storage.head(key)).toBeNull();
  });

  it("delete also removes the now-empty per-upload directory (regression)", async () => {
    const key = generateStorageKey(ctxA.workspaceId, "gecici.txt");
    await storage.put(key, new Uint8Array(3), { contentType: "text/plain", maxBytes: 10 });
    const dir = path.join(root, ...key.split("/").slice(0, -1));
    expect(await readdir(dir)).toHaveLength(1);
    await storage.delete(key);
    await expect(readdir(dir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites an existing object, even under concurrent writes (regression)", async () => {
    const key = generateStorageKey(ctxA.workspaceId, "tek.txt");
    const enc = new TextEncoder();
    const results = await Promise.allSettled([
      storage.put(key, enc.encode("first"), { contentType: "text/plain", maxBytes: 10 }),
      storage.put(key, enc.encode("other"), { contentType: "text/plain", maxBytes: 10 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(StorageExistsError);
    await expect(
      storage.put(key, enc.encode("third"), { contentType: "text/plain", maxBytes: 10 }),
    ).rejects.toBeInstanceOf(StorageExistsError);
    // No temp files are left next to the object.
    const dir = path.join(root, ...key.split("/").slice(0, -1));
    expect(await readdir(dir)).toEqual(["tek.txt"]);
    await storage.delete(key);
  });

  it("refuses keys that resolve outside its root", async () => {
    for (const bad of ["../../outside.txt", `${ctxA.workspaceId}/../../x`, "..\\..\\x/y/z"]) {
      await expect(storage.put(bad, new Uint8Array(1), { contentType: "x/y", maxBytes: 10 })).rejects.toThrow();
      await expect(storage.head(bad)).rejects.toThrow();
      await expect(storage.delete(bad)).rejects.toThrow();
    }
    expect(await readdir(path.dirname(root))).not.toContain("outside.txt");
  });
});

describe("r2 driver presigned PUT (content-swap regression)", () => {
  it("is short-lived and signed with If-None-Match: * so it cannot overwrite", async () => {
    const r2 = createR2Driver({
      accountId: "0".repeat(32),
      accessKeyId: "test",
      secretAccessKey: "test",
      bucket: "b",
    });
    const key = generateStorageKey(ctxA.workspaceId, "rapor.pdf");
    const target = await r2.createUploadTarget(key, { contentType: "application/pdf", size: 10, token: "t" });
    const url = new URL(target.url);
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(120);
    expect(url.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toContain("if-none-match");
    expect(target.headers["If-None-Match"]).toBe("*");
  });
});

describe("uploads", () => {
  it("uploads, lists and downloads a file through the service", async () => {
    const folder = await createFolder(ctxA, { name: "Teklifler" });
    const { file } = await upload(ctxA, "teklif.txt", "fiyat: 100", folder.id);
    expect(file.storageKey.startsWith(`${ctxA.workspaceId}/`)).toBe(true);
    expect(file.folderId).toBe(folder.id);

    const contents = await listFolderContents(ctxA, folder.id);
    expect(contents.files.map((f) => f.id)).toEqual([file.id]);
    expect(contents.breadcrumbs).toEqual([{ id: folder.id, name: "Teklifler" }]);

    const { download } = await getFileDownload(ctxA, file.id, storage);
    if (download.kind !== "stream") throw new Error("expected stream");
    expect((await readAll(download.stream)).toString()).toBe("fiyat: 100");
  });

  it("rejects files over 25 MB before issuing a target", async () => {
    await expect(
      createPendingUpload(ctxA, { name: "huge.zip", size: MAX_FILE_SIZE + 1, type: "application/zip" }, storage),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses replays, size mismatches and foreign tokens", async () => {
    const { file, token } = await upload(ctxA, "a.txt", "abc");
    // Replay of the PUT cannot overwrite the stored object.
    const replay = await acceptLocalUpload(ctxA.userId, token, new TextEncoder().encode("xyz"), 3, storage);
    expect(replay).toMatchObject({ ok: false, status: 409 });
    // Completing twice is idempotent.
    expect((await completeUpload(ctxA, token, storage)).id).toBe(file.id);
    // The token is bound to its uploader and workspace.
    await expect(completeUpload(ctxB, token, storage)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(completeUpload(memberA, token, storage)).rejects.toMatchObject({ code: "VALIDATION" });

    const pending = await createPendingUpload(ctxA, { name: "b.txt", size: 3, type: "text/plain" }, storage);
    expect(await acceptLocalUpload(memberA.userId, pending.token, new Uint8Array(3), 3, storage)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await acceptLocalUpload(ctxA.userId, pending.token, new Uint8Array(5), 5, storage)).toMatchObject({
      ok: false,
      status: 413,
    });
    // Body longer than declared without a Content-Length header.
    expect(await acceptLocalUpload(ctxA.userId, pending.token, new Uint8Array(5), null, storage)).toMatchObject({
      ok: false,
      status: 413,
    });
    await expect(completeUpload(ctxA, pending.token, storage)).rejects.toMatchObject({ code: "VALIDATION" });

    expect(await acceptLocalUpload(ctxA.userId, "forged.token", new Uint8Array(1), 1, storage)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  it("a replayed token cannot bring a deleted file back (single-use storage keys)", async () => {
    const { file, token } = await upload(ctxA, "geri-gelmesin.txt", "silinecek");
    expect(await db.uploadKey.findUnique({ where: { storageKey: file.storageKey } })).toMatchObject({
      workspaceId: ctxA.workspaceId,
    });

    await deleteFile(ctxA, file.id, storage);
    // Soft delete: the row sits in the trash and the object stays until it is purged.
    expect(await db.file.count({ where: { storageKey: file.storageKey, deletedAt: null } })).toBe(0);
    expect(await storage.head(file.storageKey)).not.toBeNull();
    await purgeTrashItem(ctxA, { kind: "file", id: file.id }, storage);
    expect(await db.file.count({ where: { storageKey: file.storageKey } })).toBe(0);
    expect(await storage.head(file.storageKey)).toBeNull();
    // Deleting the File keeps its UploadKey row.
    expect(await db.uploadKey.count({ where: { storageKey: file.storageKey } })).toBe(1);

    // The local PUT is refused, and so is completing (even if the bytes reappear, e.g. via an R2 presigned URL).
    const bytes = new TextEncoder().encode("silinecek");
    expect(await acceptLocalUpload(ctxA.userId, token, bytes, bytes.byteLength, storage)).toMatchObject({
      ok: false,
      status: 409,
    });
    await storage.put(file.storageKey, bytes, { contentType: "text/plain", maxBytes: bytes.byteLength });
    await expect(completeUpload(ctxA, token, storage)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await db.file.count({ where: { storageKey: file.storageKey } })).toBe(0);
    // The replayed bytes are dropped.
    expect(await storage.head(file.storageKey)).toBeNull();
  });

  it("concurrent completes of one upload create exactly one File", async () => {
    const bytes = new TextEncoder().encode("eşzamanlı");
    const pending = await createPendingUpload(
      ctxA,
      { name: "yaris.txt", size: bytes.byteLength, type: "text/plain" },
      storage,
    );
    expect(await acceptLocalUpload(ctxA.userId, pending.token, bytes, bytes.byteLength, storage)).toMatchObject({
      ok: true,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => completeUpload(ctxA, pending.token, storage)),
    );
    const ids = new Set(results.flatMap((r) => (r.status === "fulfilled" ? [r.value.id] : [])));
    expect(ids.size).toBe(1);
    for (const r of results) {
      if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "CONFLICT" });
    }
    const [id] = [...ids];
    const row = await db.file.findUniqueOrThrow({ where: { id } });
    expect(await db.file.count({ where: { storageKey: row.storageKey } })).toBe(1);
    expect(await db.uploadKey.count({ where: { storageKey: row.storageKey } })).toBe(1);
  });

  it("parallel replays of a deleted file's token never resurrect it", async () => {
    const { file, token } = await upload(ctxA, "yaris-sil.txt", "x");
    await deleteFile(ctxA, file.id, storage);
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => completeUpload(ctxA, token, storage)),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(await db.file.count({ where: { storageKey: file.storageKey, deletedAt: null } })).toBe(0);
  });

  it("UploadKey rows are workspace-scoped and survive folder deletes", async () => {
    const folder = await createFolder(ctxA, { name: "Geçici" });
    const { file, token } = await upload(ctxA, "klasorde.txt", "k", folder.id);
    await deleteFolder(ctxA, folder.id, storage);
    expect(await db.uploadKey.count({ where: { storageKey: file.storageKey, workspaceId: ctxA.workspaceId } })).toBe(1);
    await expect(completeUpload(ctxA, token, storage)).rejects.toMatchObject({ code: "CONFLICT" });
    // B's ctx cannot complete or probe A's consumed key.
    await expect(completeUpload(ctxB, token, storage)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects a signed token whose key points into another workspace", async () => {
    const token = signUploadToken({
      k: generateStorageKey(ctxB.workspaceId, "x.txt"),
      w: ctxA.workspaceId,
      u: ctxA.userId,
      f: null,
      n: "x.txt",
      s: 1,
      t: "text/plain",
      e: Date.now() + 60_000,
    });
    expect(await acceptLocalUpload(ctxA.userId, token, new Uint8Array(1), 1, storage)).toMatchObject({ ok: false });
    await expect(completeUpload(ctxA, token, storage)).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("tenant isolation", () => {
  it("ctx A cannot read, change or attach to workspace B rows", async () => {
    const folderB = await createFolder(ctxB, { name: "Gizli" });
    const docB = await createDocument(ctxB, { title: "B notu", content: "gizli", folderId: folderB.id });
    const { file: fileB } = await upload(ctxB, "b.txt", "gizli", folderB.id);
    const folderA = await createFolder(ctxA, { name: "A klasörü" });
    const { file: fileA } = await upload(ctxA, "a2.txt", "a");
    const docA = await createDocument(ctxA, { title: "A notu", content: "" });

    const nf = { code: "NOT_FOUND" };
    await expect(listFolderContents(ctxA, folderB.id)).rejects.toMatchObject(nf);
    await expect(getFolderPath(ctxA, folderB.id)).rejects.toMatchObject(nf);
    await expect(renameFolder(ctxA, { id: folderB.id, name: "x" })).rejects.toMatchObject(nf);
    await expect(moveFolder(ctxA, { id: folderB.id, targetFolderId: null })).rejects.toMatchObject(nf);
    await expect(deleteFolder(ctxA, folderB.id, storage)).rejects.toMatchObject(nf);

    // Cannot attach children to B's folder.
    await expect(createFolder(ctxA, { name: "x", parentId: folderB.id })).rejects.toMatchObject(nf);
    await expect(createDocument(ctxA, { title: "x", content: "", folderId: folderB.id })).rejects.toMatchObject(nf);
    await expect(
      createPendingUpload(ctxA, { name: "x.txt", size: 1, type: "text/plain", folderId: folderB.id }, storage),
    ).rejects.toMatchObject(nf);
    await expect(moveFile(ctxA, { id: fileA.id, targetFolderId: folderB.id })).rejects.toMatchObject(nf);
    await expect(moveDocument(ctxA, { id: docA.id, targetFolderId: folderB.id })).rejects.toMatchObject(nf);
    await expect(moveFolder(ctxA, { id: folderA.id, targetFolderId: folderB.id })).rejects.toMatchObject(nf);

    await expect(renameFile(ctxA, { id: fileB.id, name: "x" })).rejects.toMatchObject(nf);
    await expect(moveFile(ctxA, { id: fileB.id, targetFolderId: null })).rejects.toMatchObject(nf);
    await expect(deleteFile(ctxA, fileB.id, storage)).rejects.toMatchObject(nf);
    await expect(getFileDownload(ctxA, fileB.id, storage)).rejects.toMatchObject(nf);

    await expect(getDocument(ctxA, docB.id)).rejects.toMatchObject(nf);
    await expect(updateDocument(ctxA, { id: docB.id, title: "x", content: "" })).rejects.toMatchObject(nf);
    await expect(moveDocument(ctxA, { id: docB.id, targetFolderId: null })).rejects.toMatchObject(nf);
    await expect(deleteDocument(ctxA, docB.id)).rejects.toMatchObject(nf);

    // Listings never include B rows.
    const rootA = await listFolderContents(ctxA, null);
    const treeA = await listFolderTree(ctxA);
    expect(treeA.some((f) => f.id === folderB.id)).toBe(false);
    expect(rootA.files.some((f) => f.id === fileB.id)).toBe(false);
    expect(rootA.documents.some((d) => d.id === docB.id)).toBe(false);

    // Download authorisation by file id checks membership of the file's workspace.
    expect(await authorizeFileAccess(ctxA.userId, fileB.id)).toBeNull();
    expect(await authorizeFileAccess(ctxB.userId, fileB.id)).toMatchObject({ workspaceId: ctxB.workspaceId });
    expect(await authorizeFileAccess(ctxA.userId, "nonexistent")).toBeNull();

    // B rows are untouched.
    expect(await db.file.findUnique({ where: { id: fileB.id } })).toMatchObject({ name: "b.txt", folderId: folderB.id });
    expect(await db.document.findUnique({ where: { id: docB.id } })).toMatchObject({ title: "B notu" });
    expect(await db.folder.findUnique({ where: { id: folderB.id } })).toMatchObject({ name: "Gizli", parentId: null });
    expect(await storage.head(fileB.storageKey)).not.toBeNull();
  });
});

describe("folder tree", () => {
  it("prevents moving a folder into itself or its descendants", async () => {
    const a = await createFolder(ctxA, { name: "Döngü A" });
    const b = await createFolder(ctxA, { name: "Döngü B", parentId: a.id });
    const c = await createFolder(ctxA, { name: "Döngü C", parentId: b.id });

    await expect(moveFolder(ctxA, { id: a.id, targetFolderId: a.id })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(moveFolder(ctxA, { id: a.id, targetFolderId: b.id })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(moveFolder(ctxA, { id: a.id, targetFolderId: c.id })).rejects.toMatchObject({ code: "VALIDATION" });
    expect((await db.folder.findUnique({ where: { id: a.id } }))?.parentId).toBeNull();

    await moveFolder(ctxA, { id: c.id, targetFolderId: null });
    await moveFolder(ctxA, { id: a.id, targetFolderId: c.id });
    expect(await getFolderPath(ctxA, b.id)).toEqual([
      { id: c.id, name: "Döngü C" },
      { id: a.id, name: "Döngü A" },
      { id: b.id, name: "Döngü B" },
    ]);
  });

  it("rejects duplicate folder names in the same parent", async () => {
    await createFolder(ctxA, { name: "Fatura" });
    await expect(createFolder(ctxA, { name: "fatura" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("trashes a folder recursively; restoring brings the whole tree back, purging removes the objects", async () => {
    const top = await createFolder(ctxA, { name: "Silinecek" });
    const sub = await createFolder(ctxA, { name: "Alt", parentId: top.id });
    const deep = await createFolder(ctxA, { name: "Derin", parentId: sub.id });
    const f1 = (await upload(ctxA, "1.txt", "1", top.id)).file;
    const f2 = (await upload(ctxA, "2.txt", "2", deep.id)).file;
    const d1 = await createDocument(ctxA, { title: "Not", content: "x", folderId: sub.id });
    const keep = (await upload(ctxA, "kalsin.txt", "k")).file;

    const res = await deleteFolder(ctxA, top.id, storage);
    expect(res).toMatchObject({ deletedFolders: 3, deletedFiles: 2, deletedDocuments: 1 });
    const live = { deletedAt: null };
    expect(await db.folder.count({ where: { id: { in: [top.id, sub.id, deep.id] }, ...live } })).toBe(0);
    expect(await db.file.count({ where: { id: { in: [f1.id, f2.id] }, ...live } })).toBe(0);
    expect(await db.document.count({ where: { id: d1.id, ...live } })).toBe(0);
    // Trashed, not removed: the objects are still there.
    expect(await storage.head(f1.storageKey)).not.toBeNull();
    expect(await storage.head(f2.storageKey)).not.toBeNull();
    expect(await storage.head(keep.storageKey)).not.toBeNull();

    await restoreTrashItem(ctxA, { kind: "folder", id: top.id });
    expect(await db.folder.count({ where: { id: { in: [top.id, sub.id, deep.id] }, ...live } })).toBe(3);
    expect(await db.file.count({ where: { id: { in: [f1.id, f2.id] }, ...live } })).toBe(2);
    expect(await db.document.count({ where: { id: d1.id, ...live } })).toBe(1);

    await deleteFolder(ctxA, top.id, storage);
    await purgeTrashItem(ctxA, { kind: "folder", id: top.id }, storage);
    expect(await db.folder.count({ where: { id: { in: [top.id, sub.id, deep.id] } } })).toBe(0);
    expect(await db.file.count({ where: { id: { in: [f1.id, f2.id] } } })).toBe(0);
    expect(await db.document.count({ where: { id: d1.id } })).toBe(0);
    expect(await storage.head(f1.storageKey)).toBeNull();
    expect(await storage.head(f2.storageKey)).toBeNull();
    expect(await storage.head(keep.storageKey)).not.toBeNull();
  });
});

describe("permissions", () => {
  it("members cannot modify others' content; admins can", async () => {
    const folder = await createFolder(memberA, { name: "Üye klasörü" });
    const { file } = await upload(memberA, "uye.txt", "u");
    const doc = await createDocument(memberA, { title: "Üye notu", content: "x" });
    const fb = { code: "FORBIDDEN" };

    await expect(renameFolder(member2A, { id: folder.id, name: "x" })).rejects.toMatchObject(fb);
    await expect(moveFolder(member2A, { id: folder.id, targetFolderId: null })).rejects.toMatchObject(fb);
    await expect(deleteFolder(member2A, folder.id, storage)).rejects.toMatchObject(fb);
    await expect(renameFile(member2A, { id: file.id, name: "x" })).rejects.toMatchObject(fb);
    await expect(moveFile(member2A, { id: file.id, targetFolderId: folder.id })).rejects.toMatchObject(fb);
    await expect(deleteFile(member2A, file.id, storage)).rejects.toMatchObject(fb);
    await expect(updateDocument(member2A, { id: doc.id, title: "x", content: "" })).rejects.toMatchObject(fb);
    await expect(deleteDocument(member2A, doc.id)).rejects.toMatchObject(fb);

    // Any member can read and download.
    expect((await getDocument(member2A, doc.id)).document.id).toBe(doc.id);
    await expect(getFileDownload(member2A, file.id, storage)).resolves.toBeTruthy();
    // ...and add content into someone else's folder.
    const own = await createDocument(member2A, { title: "Benim", content: "", folderId: folder.id });

    // The author can edit; a member cannot delete their folder if it holds others' items.
    await renameFolder(memberA, { id: folder.id, name: "Yeni ad" });
    await expect(deleteFolder(memberA, folder.id, storage)).rejects.toMatchObject(fb);
    expect(await db.document.count({ where: { id: own.id } })).toBe(1);

    // Admin can do everything.
    await renameFile(adminA, { id: file.id, name: "yonetici.txt" });
    await moveFile(adminA, { id: file.id, targetFolderId: folder.id });
    await updateDocument(adminA, { id: doc.id, title: "Düzenlendi", content: "y" });
    await deleteDocument(adminA, doc.id);
    await deleteFile(adminA, file.id, storage);
    expect(await db.file.count({ where: { id: file.id, deletedAt: null } })).toBe(0);
    await deleteFolder(adminA, folder.id, storage);
    expect(await db.folder.count({ where: { id: folder.id, deletedAt: null } })).toBe(0);
    expect(await db.document.count({ where: { id: own.id, deletedAt: null } })).toBe(0);
  });

  it("validates input", async () => {
    await expect(createFolder(ctxA, { name: "   " })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createFolder(ctxA, { name: "a/b" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(createDocument(ctxA, { title: "", content: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
