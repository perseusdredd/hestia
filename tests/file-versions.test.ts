import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { createLocalDriver, type StorageDriver } from "@/lib/storage";
import type { TenantContext } from "@/lib/tenant-context";
import {
  acceptLocalUpload,
  authorizeFileAccess,
  completeUpload,
  completeVersionUpload,
  createFolder,
  createPendingUpload,
  createVersionUpload,
  deleteFile,
  getFileDownload,
  getFileVersionDownload,
  hardDeleteFile,
  listFileVersions,
  moveFile,
  renameFile,
} from "@/server/files";
import { createProject } from "@/server/projects";
import { purgeTrashItem } from "@/server/trash";

import { cleanup, createMember, createTestUser, createTestWorkspace, disconnect } from "./helpers";

let root: string;
let storage: StorageDriver;
let ctxA: TenantContext;
let ctxB: TenantContext;
let memberA: TenantContext;
let otherA: TenantContext;
let adminA: TenantContext;
let guestA: TenantContext;

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function upload(ctx: TenantContext, name: string, content: string, folderId: string | null = null) {
  const bytes = new TextEncoder().encode(content);
  const pending = await createPendingUpload(
    ctx,
    { name, size: bytes.byteLength, type: "text/plain", folderId },
    storage,
  );
  await acceptLocalUpload(ctx.userId, pending.token, bytes, bytes.byteLength, storage);
  return completeUpload(ctx, pending.token, storage);
}

/** Full "Yeni sürüm" flow; returns the token too. */
async function newVersion(ctx: TenantContext, fileId: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  const pending = await createVersionUpload(
    ctx,
    { fileId, size: bytes.byteLength, type: "text/plain" },
    storage,
  );
  const put = await acceptLocalUpload(ctx.userId, pending.token, bytes, bytes.byteLength, storage);
  expect(put.ok).toBe(true);
  const file = await completeVersionUpload(ctx, pending.token, storage);
  return { file, token: pending.token };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hestia-fver-"));
  storage = createLocalDriver(root);
  const ownerA = await createTestUser();
  const ownerB = await createTestUser();
  ({ ctx: ctxA } = await createTestWorkspace(ownerA.id));
  ({ ctx: ctxB } = await createTestWorkspace(ownerB.id));
  ({ ctx: memberA } = await createMember(ctxA.workspaceId, "MEMBER"));
  ({ ctx: otherA } = await createMember(ctxA.workspaceId, "MEMBER"));
  ({ ctx: adminA } = await createMember(ctxA.workspaceId, "ADMIN"));
  ({ ctx: guestA } = await createMember(ctxA.workspaceId, "GUEST"));
});

afterAll(async () => {
  await cleanup();
  await disconnect();
  await rm(root, { recursive: true, force: true });
});

describe("new version", () => {
  it("snapshots the current bytes into a history row and updates the current pointer", async () => {
    const file = await upload(memberA, "plan.txt", "v1");
    const { file: updated } = await newVersion(memberA, file.id, "version two");

    expect(updated.id).toBe(file.id);
    expect(updated.storageKey).not.toBe(file.storageKey);
    expect(updated.size).toBe("version two".length);
    // name, folder and ownership stay as they were
    expect(updated.name).toBe("plan.txt");
    expect(updated.folderId).toBe(file.folderId);
    expect(updated.uploadedById).toBe(file.uploadedById);

    const rows = await db.fileVersion.findMany({ where: { fileId: file.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: 1,
      storageKey: file.storageKey,
      size: 2,
      workspaceId: ctxA.workspaceId,
      uploadedById: memberA.userId,
    });

    const { download } = await getFileDownload(memberA, file.id, storage);
    expect(download.kind).toBe("stream");
    if (download.kind === "stream") expect(await readAll(download.stream)).toBe("version two");
  });

  it("numbers further versions and tracks who uploaded the current bytes", async () => {
    const file = await upload(memberA, "rapor.txt", "one");
    await newVersion(memberA, file.id, "two");
    await newVersion(adminA, file.id, "three"); // admin may replace someone else's file
    const list = await listFileVersions(memberA, file.id);
    expect(list.map((v) => [v.version, v.current, v.size])).toEqual([
      [3, true, 5],
      [2, false, 3],
      [1, false, 3],
    ]);
    expect(list[0].uploadedBy.id).toBe(adminA.userId); // current bytes: the admin
    expect(list[1].uploadedBy.id).toBe(memberA.userId);
    expect(list[0].id).toBeNull();
    // the File stays owned by the original uploader
    expect((await db.file.findUniqueOrThrow({ where: { id: file.id } })).uploadedById).toBe(memberA.userId);
  });

  it("returns the file on a repeated complete (idempotent) and does not add history", async () => {
    const file = await upload(memberA, "idem.txt", "a");
    const { token, file: after } = await newVersion(memberA, file.id, "b");
    const again = await completeVersionUpload(memberA, token, storage);
    expect(again.storageKey).toBe(after.storageKey);
    expect(await db.fileVersion.count({ where: { fileId: file.id } })).toBe(1);
  });

  it("refuses a version token on the plain completeUpload and a plain token on completeVersionUpload", async () => {
    const file = await upload(memberA, "mix.txt", "a");
    const bytes = new TextEncoder().encode("x");
    const vp = await createVersionUpload(memberA, { fileId: file.id, size: 1, type: "text/plain" }, storage);
    await acceptLocalUpload(memberA.userId, vp.token, bytes, 1, storage);
    await expect(completeUpload(memberA, vp.token, storage)).rejects.toMatchObject({ code: "VALIDATION" });

    const np = await createPendingUpload(memberA, { name: "n.txt", size: 1, type: "text/plain" }, storage);
    await acceptLocalUpload(memberA.userId, np.token, bytes, 1, storage);
    await expect(completeVersionUpload(memberA, np.token, storage)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.fileVersion.count({ where: { fileId: file.id } })).toBe(0);
  });

  it("rejects a size mismatch and keeps the file untouched", async () => {
    const file = await upload(memberA, "size.txt", "abc");
    const pending = await createVersionUpload(memberA, { fileId: file.id, size: 10, type: "text/plain" }, storage);
    // bypass the local size check by placing different bytes directly
    await storage.put(
      (await import("@/lib/storage/upload-token")).verifyUploadToken(pending.token)!.k,
      new TextEncoder().encode("xy"),
      { contentType: "text/plain", maxBytes: 100 },
    );
    await expect(completeVersionUpload(memberA, pending.token, storage)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const row = await db.file.findUniqueOrThrow({ where: { id: file.id } });
    expect(row.storageKey).toBe(file.storageKey);
    expect(await db.fileVersion.count({ where: { fileId: file.id } })).toBe(0);
  });

  it("only the uploader or an admin may add a version; guests never", async () => {
    const file = await upload(memberA, "own.txt", "a");
    await expect(
      createVersionUpload(otherA, { fileId: file.id, size: 1, type: "text/plain" }, storage),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      createVersionUpload(guestA, { fileId: file.id, size: 1, type: "text/plain" }, storage),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // a token minted for the owner cannot be completed by another member or a guest
    const bytes = new TextEncoder().encode("z");
    const pending = await createVersionUpload(memberA, { fileId: file.id, size: 1, type: "text/plain" }, storage);
    await acceptLocalUpload(memberA.userId, pending.token, bytes, 1, storage);
    await expect(completeVersionUpload(otherA, pending.token, storage)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(completeVersionUpload(guestA, pending.token, storage)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await db.fileVersion.count({ where: { fileId: file.id } })).toBe(0);
  });

  it("is isolated per workspace and refuses trashed files", async () => {
    const file = await upload(memberA, "iso.txt", "a");
    await expect(
      createVersionUpload(ctxB, { fileId: file.id, size: 1, type: "text/plain" }, storage),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listFileVersions(ctxB, file.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    await deleteFile(memberA, file.id);
    await expect(
      createVersionUpload(memberA, { fileId: file.id, size: 1, type: "text/plain" }, storage),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not let a guest-invisible (internal) file be versioned or listed by a guest", async () => {
    const folder = await createFolder(ctxA, { name: "Gizli", internal: true });
    const file = await upload(memberA, "gizli.txt", "a", folder.id);
    await expect(listFileVersions(guestA, file.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("downloading a version", () => {
  it("returns the bytes of an old version", async () => {
    const file = await upload(memberA, "dl.txt", "eski icerik");
    await newVersion(memberA, file.id, "yeni icerik");
    const [, old] = await listFileVersions(memberA, file.id);
    const { download, version } = await getFileVersionDownload(memberA, file.id, old.id!, storage);
    expect(version.version).toBe(1);
    expect(download.kind).toBe("stream");
    if (download.kind === "stream") expect(await readAll(download.stream)).toBe("eski icerik");
  });

  it("authorises like the file: members only, workspace isolated, version must belong to the file", async () => {
    const file = await upload(memberA, "auth.txt", "a");
    const other = await upload(memberA, "other.txt", "a");
    await newVersion(memberA, file.id, "b");
    await newVersion(memberA, other.id, "b");
    const v = (await listFileVersions(memberA, file.id))[1].id!;
    const otherV = (await listFileVersions(memberA, other.id))[1].id!;

    await expect(getFileVersionDownload(ctxB, file.id, v, storage)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getFileVersionDownload(memberA, file.id, otherV, storage)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getFileVersionDownload(memberA, file.id, "nope", storage)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // route-level gate: a non-member of the workspace gets no ctx at all
    const outsider = await createTestUser();
    expect(await authorizeFileAccess(outsider.id, file.id)).toBeNull();
    expect(await authorizeFileAccess(memberA.userId, file.id)).not.toBeNull();
  });

  it("hides versions of internal and trashed files from guests / everyone", async () => {
    const folder = await createFolder(ctxA, { name: "Ekip", internal: true });
    const hidden = await upload(memberA, "ekip.txt", "a", folder.id);
    await newVersion(memberA, hidden.id, "b");
    const hv = (await listFileVersions(memberA, hidden.id))[1].id!;
    await expect(getFileVersionDownload(guestA, hidden.id, hv, storage)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    const open = await upload(memberA, "acik.txt", "a");
    await newVersion(memberA, open.id, "b");
    const ov = (await listFileVersions(memberA, open.id))[1].id!;
    const ok = await getFileVersionDownload(guestA, open.id, ov, storage); // guests may read non-internal
    expect(ok.version.id).toBe(ov);
    await deleteFile(memberA, open.id);
    await expect(getFileVersionDownload(memberA, open.id, ov, storage)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("rename and move", () => {
  it("renames the file, keeping its versions", async () => {
    const file = await upload(memberA, "eski-ad.txt", "a");
    await newVersion(memberA, file.id, "b");
    const renamed = await renameFile(memberA, { id: file.id, name: "yeni-ad.txt" });
    expect(renamed.name).toBe("yeni-ad.txt");
    expect(await db.fileVersion.count({ where: { fileId: file.id } })).toBe(1);
    await expect(renameFile(otherA, { id: file.id, name: "x.txt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(renameFile(ctxB, { id: file.id, name: "x.txt" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await renameFile(adminA, { id: file.id, name: "admin.txt" })).name).toBe("admin.txt");
  });

  it("move follows the destination folder's project and internal flag", async () => {
    const project = await createProject(ctxA, { name: "Proje X" });
    const dest = await createFolder(ctxA, { name: "Hedef", projectId: project.id, internal: true });
    const file = await upload(memberA, "tasi.txt", "a");

    const moved = await moveFile(memberA, { id: file.id, targetFolderId: dest.id });
    expect(moved.folderId).toBe(dest.id);
    const folder = await db.folder.findUniqueOrThrow({ where: { id: moved.folderId! } });
    expect(folder.projectId).toBe(project.id);
    expect(folder.internal).toBe(true);
    // a guest can no longer see it: it is internal now that it lives in the internal folder
    await expect(listFileVersions(guestA, file.id)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const back = await moveFile(memberA, { id: file.id, targetFolderId: null });
    expect(back.folderId).toBeNull();
  });

  it("refuses moves into other workspaces' folders and by non-owners", async () => {
    const foreign = await createFolder(ctxB, { name: "Yabanci" });
    const file = await upload(memberA, "m.txt", "a");
    await expect(moveFile(memberA, { id: file.id, targetFolderId: foreign.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const dest = await createFolder(ctxA, { name: "D" });
    await expect(moveFile(otherA, { id: file.id, targetFolderId: dest.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("a guest cannot rename or move, even a file they uploaded", async () => {
    const file = await upload(guestA, "misafir.txt", "a");
    const dest = await createFolder(ctxA, { name: "Misafir hedef" });
    await expect(renameFile(guestA, { id: file.id, name: "x.txt" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(moveFile(guestA, { id: file.id, targetFolderId: dest.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      createVersionUpload(guestA, { fileId: file.id, size: 1, type: "text/plain" }, storage),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await db.file.findUniqueOrThrow({ where: { id: file.id } })).name).toBe("misafir.txt");
  });
});

describe("purging", () => {
  it("trash purge deletes the current object and every version object", async () => {
    const file = await upload(memberA, "purge.txt", "one");
    await newVersion(memberA, file.id, "two");
    const { file: last } = await newVersion(memberA, file.id, "three");
    const keys = [
      ...(await db.fileVersion.findMany({ where: { fileId: file.id } })).map((v) => v.storageKey),
      last.storageKey,
    ];
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(await storage.head(k)).not.toBeNull();

    await deleteFile(memberA, file.id);
    // still retained while in the trash
    for (const k of keys) expect(await storage.head(k)).not.toBeNull();

    await purgeTrashItem(memberA, { kind: "file", id: file.id }, storage);
    for (const k of keys) expect(await storage.head(k)).toBeNull();
    expect(await db.file.count({ where: { id: file.id } })).toBe(0);
    expect(await db.fileVersion.count({ where: { fileId: file.id } })).toBe(0);
  });

  it("hardDeleteFile also removes version objects", async () => {
    const file = await upload(memberA, "hard.txt", "one");
    const { file: last } = await newVersion(memberA, file.id, "two");
    const [old] = await db.fileVersion.findMany({ where: { fileId: file.id } });
    await hardDeleteFile(memberA, file.id, storage);
    expect(await storage.head(old.storageKey)).toBeNull();
    expect(await storage.head(last.storageKey)).toBeNull();
  });

  it("purging one workspace's file leaves other workspaces' objects alone", async () => {
    const mine = await upload(memberA, "mine.txt", "a");
    await newVersion(memberA, mine.id, "b");
    const theirs = await upload(ctxB, "theirs.txt", "a");
    await newVersion(ctxB, theirs.id, "b");
    const theirKeys = [
      theirs.storageKey,
      ...(await db.fileVersion.findMany({ where: { fileId: theirs.id } })).map((v) => v.storageKey),
    ];
    await deleteFile(memberA, mine.id);
    await purgeTrashItem(memberA, { kind: "file", id: mine.id }, storage);
    for (const k of theirKeys) expect(await storage.head(k)).not.toBeNull();
  });
});
