import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { formatMentionToken } from "@/lib/mentions";
import type { TenantContext } from "@/lib/tenant-context";
import { subjectInternal, syncActivityInternal, forgetActivity } from "@/server/activity";
import { commentClientWhere } from "@/server/client-visibility";
import { listReactions, toggleReaction } from "@/server/reactions";
import { addComment, commentSubjectPath, countComments, deleteComment, listComments } from "@/server/comments";
import { ServiceError } from "@/server/errors";
import { searchWorkspace } from "@/server/search";

import { cleanup, createMember, createTestUser, createTestWorkspace, uniqueSuffix } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e.code;
    throw e;
  }
  return "OK";
}

describe("comments on files", () => {
  let owner: TenantContext;
  let uploader: TenantContext;
  let bob: TenantContext;
  let guest: TenantContext;
  let other: TenantContext;
  let publicFile: { type: "file"; id: string };
  let internalFile: { type: "file"; id: string };
  let rootFile: { type: "file"; id: string };
  let otherFile: { type: "file"; id: string };
  let chatFile: { type: "file"; id: string };

  const mkFile = async (ws: string, by: string, extra: Record<string, unknown> = {}) => {
    const f = await db.file.create({
      data: {
        workspaceId: ws,
        uploadedById: by,
        name: `dosya-${uniqueSuffix()}.pdf`,
        mimeType: "application/pdf",
        size: 5,
        storageKey: `${ws}/${uniqueSuffix()}.pdf`,
        ...extra,
      },
    });
    return { type: "file" as const, id: f.id };
  };

  beforeAll(async () => {
    owner = (await createTestWorkspace((await createTestUser()).id)).ctx;
    uploader = (await createMember(owner.workspaceId)).ctx;
    bob = (await createMember(owner.workspaceId)).ctx;
    guest = (await createMember(owner.workspaceId, "GUEST")).ctx;
    other = (await createTestWorkspace((await createTestUser()).id)).ctx;
    const open = await db.folder.create({
      data: { workspaceId: owner.workspaceId, createdById: owner.userId, name: "Açık" },
    });
    const closed = await db.folder.create({
      data: { workspaceId: owner.workspaceId, createdById: owner.userId, name: "Ekip", internal: true },
    });
    publicFile = await mkFile(owner.workspaceId, uploader.userId, { folderId: open.id });
    internalFile = await mkFile(owner.workspaceId, uploader.userId, { folderId: closed.id });
    rootFile = await mkFile(owner.workspaceId, uploader.userId);
    chatFile = await mkFile(owner.workspaceId, uploader.userId, { fromChat: true });
    otherFile = await mkFile(other.workspaceId, other.userId);
  });

  beforeEach(async () => {
    await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
  });

  it("comments, lists oldest first and counts", async () => {
    const f = await mkFile(owner.workspaceId, uploader.userId);
    const a = await addComment(bob, f, { body: "ilk" });
    await addComment(uploader, f, { body: "ikinci" });
    expect(a.fileId).toBe(f.id);
    expect(a.postId ?? a.todoItemId ?? a.documentId ?? a.eventId).toBeNull();
    expect((await listComments(bob, f)).map((c) => c.body)).toEqual(["ilk", "ikinci"]);
    expect(await countComments(bob, "file", [f.id, otherFile.id])).toEqual({ [f.id]: 2 });
  });

  it("path points to the file preview page", () => {
    expect(commentSubjectPath(publicFile)).toBe(`files/view/${publicFile.id}`);
  });

  it("notifies the uploader and earlier commenters, with the file path", async () => {
    const f = await mkFile(owner.workspaceId, uploader.userId);
    await addComment(bob, f, { body: "merhaba" });
    let rows = await db.notification.findMany({ where: { workspaceId: owner.workspaceId } });
    expect(rows.map((r) => [r.userId, r.type, r.path])).toEqual([[uploader.userId, "COMMENT", `files/view/${f.id}`]]);
    expect(rows[0].title).toContain("dosyasına yorum yaptı");
    await db.notification.deleteMany({ where: { workspaceId: owner.workspaceId } });
    await addComment(uploader, f, { body: "cevap" });
    rows = await db.notification.findMany({ where: { workspaceId: owner.workspaceId } });
    expect(rows.map((r) => r.userId)).toEqual([bob.userId]);
  });

  it("@mention notifies the member once with MENTION", async () => {
    const f = await mkFile(owner.workspaceId, uploader.userId);
    const token = formatMentionToken({ id: bob.userId, name: "Bob" });
    await addComment(uploader, f, { body: `bak ${token}` });
    const rows = await db.notification.findMany({ where: { workspaceId: owner.workspaceId } });
    expect(rows.map((r) => [r.userId, r.type])).toEqual([[bob.userId, "MENTION"]]);
    expect(rows[0].path).toBe(`files/view/${f.id}`);
  });

  it("records COMMENT_CREATED activity for the file", async () => {
    const f = await mkFile(owner.workspaceId, uploader.userId);
    await addComment(bob, f, { body: "etkinlik" });
    const act = await db.activity.findFirst({
      where: { workspaceId: owner.workspaceId, type: "COMMENT_CREATED", path: `files/view/${f.id}` },
    });
    expect(act).not.toBeNull();
  });

  describe("guest visibility", () => {
    it("guest comments on and reads a file in a non-internal folder or at the root", async () => {
      for (const f of [publicFile, rootFile]) {
        await addComment(bob, f, { body: "ekip yorumu" });
        const c = await addComment(guest, f, { body: "müşteri yorumu" });
        expect((await listComments(guest, f)).some((x) => x.id === c.id)).toBe(true);
      }
    });

    it("guest cannot comment on, list or delete comments of an internal file", async () => {
      const c = await addComment(bob, internalFile, { body: "gizli" });
      expect(await code(addComment(guest, internalFile, { body: "x" }))).toBe("NOT_FOUND");
      expect(await code(listComments(guest, internalFile))).toBe("NOT_FOUND");
      expect(await code(deleteComment(guest, c.id))).toBe("NOT_FOUND");
      expect(await code(addComment(guest, chatFile, { body: "x" }))).toBe("NOT_FOUND");
      expect(await code(listComments(bob, internalFile))).toBe("OK");
    });

    it("internal-file comments do not notify guests", async () => {
      await addComment(bob, internalFile, { body: "ekip içi" });
      expect(await db.notification.count({ where: { userId: guest.userId } })).toBe(0);
    });

    it("guest search does not surface comments of an internal file", async () => {
      const marker = `qf${uniqueSuffix()}`;
      await addComment(bob, internalFile, { body: `gizli ${marker}` });
      await addComment(bob, publicFile, { body: `açık ${marker}` });
      const g = await searchWorkspace(guest, { q: marker, types: ["comment"], limitPerType: 10 });
      expect(g.groups[0].items.map((i) => i.path)).toEqual([`files/view/${publicFile.id}`]);
      const m = await searchWorkspace(bob, { q: marker, types: ["comment"], limitPerType: 10 });
      expect(m.groups[0].items).toHaveLength(2);
    });
  });

  describe("isolation and lifecycle", () => {
    it("rejects a file of another workspace", async () => {
      expect(await code(addComment(owner, otherFile, { body: "x" }))).toBe("NOT_FOUND");
      expect(await code(listComments(owner, otherFile))).toBe("NOT_FOUND");
    });

    it("rejects a trashed file", async () => {
      const f = await mkFile(owner.workspaceId, uploader.userId);
      await addComment(bob, f, { body: "var" });
      await db.file.update({ where: { id: f.id }, data: { deletedAt: new Date() } });
      expect(await code(addComment(bob, f, { body: "x" }))).toBe("NOT_FOUND");
      expect(await code(listComments(bob, f))).toBe("NOT_FOUND");
    });

    it("deleting the file removes its comments", async () => {
      const f = await mkFile(owner.workspaceId, uploader.userId);
      const c = await addComment(bob, f, { body: "silinecek" });
      await db.file.delete({ where: { id: f.id } });
      expect(await db.comment.findUnique({ where: { id: c.id } })).toBeNull();
    });

    it("CHECK constraint rejects zero or multiple subjects including a file", async () => {
      const base = { workspaceId: owner.workspaceId, authorId: bob.userId, body: "x" };
      const post = await db.post.create({
        data: { workspaceId: owner.workspaceId, authorId: bob.userId, title: "P", body: "b" },
      });
      await expect(db.comment.create({ data: base })).rejects.toThrow();
      await expect(db.comment.create({ data: { ...base, fileId: publicFile.id, postId: post.id } })).rejects.toThrow();
      await expect(db.comment.create({ data: { ...base, fileId: publicFile.id } })).resolves.toBeTruthy();
      await expect(db.comment.create({ data: { ...base, postId: post.id } })).resolves.toBeTruthy();
    });
  });
  describe("comment guest filter, activity internal flag", () => {
    const actOf = (commentId: string) =>
      db.activity.findFirst({ where: { workspaceId: owner.workspaceId, subjectType: "comment", subjectId: commentId } });

    it("commentClientWhere hides comments of internal / chat files from guests only", async () => {
      const ci = await addComment(bob, internalFile, { body: "gizli-f" });
      const cc = await addComment(bob, chatFile, { body: "gizli-sohbet" });
      const cp = await addComment(bob, publicFile, { body: "acik-f" });
      const ids = [ci.id, cc.id, cp.id];
      const seen = async (c: TenantContext) =>
        (await db.comment.findMany({ where: { id: { in: ids }, ...commentClientWhere(c) } })).map((x) => x.id).sort();
      expect(await seen(guest)).toEqual([cp.id]);
      expect(await seen(bob)).toEqual([...ids].sort());
    });

    it("guest cannot react to or read reactions on a comment of an internal file", async () => {
      const ci = await addComment(bob, internalFile, { body: "r-gizli" });
      const cp = await addComment(bob, publicFile, { body: "r-acik" });
      expect(await code(toggleReaction(guest, { type: "comment", id: ci.id }, "👍"))).toBe("NOT_FOUND");
      expect(await code(toggleReaction(guest, { type: "comment", id: cp.id }, "👍"))).toBe("OK");
      await toggleReaction(bob, { type: "comment", id: ci.id }, "❤️");
      expect(await listReactions(guest, "comment", [ci.id])).toEqual({});
      expect(Object.keys(await listReactions(bob, "comment", [ci.id]))).toEqual([ci.id]);
    });

    it("comment activity on an internal-folder or chat file is internal; public stays visible", async () => {
      const ci = await addComment(bob, internalFile, { body: "a1" });
      const cc = await addComment(bob, chatFile, { body: "a2" });
      const cp = await addComment(bob, publicFile, { body: "a3" });
      expect(await subjectInternal(owner.workspaceId, { type: "comment", id: ci.id })).toBe(true);
      expect((await actOf(ci.id))?.internal).toBe(true);
      expect((await actOf(cc.id))?.internal).toBe(true);
      expect((await actOf(cp.id))?.internal).toBe(false);
    });

    it("moving a file into an internal folder re-marks its comment activity (file case)", async () => {
      const f = await mkFile(owner.workspaceId, uploader.userId);
      const c = await addComment(bob, f, { body: "tasinacak" });
      expect((await actOf(c.id))?.internal).toBe(false);
      const closed = await db.folder.create({
        data: { workspaceId: owner.workspaceId, createdById: owner.userId, name: "K", internal: true },
      });
      await db.file.update({ where: { id: f.id }, data: { folderId: closed.id } });
      await syncActivityInternal(owner, f);
      expect((await actOf(c.id))?.internal).toBe(true);
      await db.file.update({ where: { id: f.id }, data: { folderId: null } });
      await syncActivityInternal(owner, f);
      expect((await actOf(c.id))?.internal).toBe(false);
    });

    it("toggling a folder internal re-marks file comment activity in the subtree (folder case)", async () => {
      const folder = await db.folder.create({
        data: { workspaceId: owner.workspaceId, createdById: owner.userId, name: "T" },
      });
      const sub = await db.folder.create({
        data: { workspaceId: owner.workspaceId, createdById: owner.userId, name: "T2", parentId: folder.id },
      });
      const f1 = await mkFile(owner.workspaceId, uploader.userId, { folderId: folder.id });
      const f2 = await mkFile(owner.workspaceId, uploader.userId, { folderId: sub.id });
      const c1 = await addComment(bob, f1, { body: "k1" });
      const c2 = await addComment(bob, f2, { body: "k2" });
      expect((await actOf(c1.id))?.internal).toBe(false);
      await db.folder.updateMany({ where: { id: { in: [folder.id, sub.id] } }, data: { internal: true } });
      await syncActivityInternal(owner, { type: "folder", id: folder.id });
      expect((await actOf(c1.id))?.internal).toBe(true);
      expect((await actOf(c2.id))?.internal).toBe(true);
      await db.folder.updateMany({ where: { id: { in: [folder.id, sub.id] } }, data: { internal: false } });
      await syncActivityInternal(owner, { type: "folder", id: folder.id });
      expect((await actOf(c1.id))?.internal).toBe(false);
      expect((await actOf(c2.id))?.internal).toBe(false);
    });

    it("forgetActivity on a file also drops its comment activity rows", async () => {
      const f = await mkFile(owner.workspaceId, uploader.userId);
      const c = await addComment(bob, f, { body: "silinecek" });
      expect(await actOf(c.id)).not.toBeNull();
      await forgetActivity(owner, [f]);
      expect(await actOf(c.id)).toBeNull();
    });
  });
});
