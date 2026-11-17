import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { CHAT_IMAGE_MAX_BYTES } from "@/lib/pusher/chat-protocol";
import { createLocalDriver, type StorageDriver } from "@/lib/storage";
import type { TenantContext } from "@/lib/tenant-context";
import { deleteMessage, getMessage, sendChatMessage } from "@/server/chat";
import { ServiceError } from "@/server/errors";
import {
  acceptLocalUpload,
  completeUpload,
  createChatImageUpload,
  listFolderContents,
  listRecentItems,
} from "@/server/files";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ServiceError) return e.code;
    throw e;
  }
  return "OK";
}

// 8-byte PNG signature + padding: enough for the magic-number check.
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]);

let root: string;
let storage: StorageDriver;
let owner: TenantContext;
let alice: TenantContext;
let bob: TenantContext;
let other: TenantContext;

/** Full local flow: chat upload -> PUT -> complete. Returns the File row. */
async function uploadPhoto(ctx: TenantContext, name = "kedi.png", type = "image/png") {
  const pending = await createChatImageUpload(ctx, { name, size: PNG.byteLength, type }, storage);
  const put = await acceptLocalUpload(ctx.userId, pending.token, PNG, PNG.byteLength, storage);
  expect(put).toEqual({ ok: true, size: PNG.byteLength });
  return completeUpload(ctx, pending.token, storage);
}

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "hestia-chatphoto-"));
  storage = createLocalDriver(root);
  const u1 = await createTestUser();
  ({ ctx: owner } = await createTestWorkspace(u1.id));
  ({ ctx: alice } = await createMember(owner.workspaceId, "MEMBER"));
  ({ ctx: bob } = await createMember(owner.workspaceId, "MEMBER"));
  const u2 = await createTestUser();
  ({ ctx: other } = await createTestWorkspace(u2.id));
});

afterAll(async () => {
  await cleanup();
  await rm(root, { recursive: true, force: true });
});

describe("chat photos: upload validation", () => {
  it("accepts only previewable image types up to 10 MB", async () => {
    expect(await code(createChatImageUpload(alice, { name: "a.pdf", size: 10, type: "application/pdf" }, storage))).toBe("VALIDATION");
    expect(await code(createChatImageUpload(alice, { name: "a.svg", size: 10, type: "image/svg+xml" }, storage))).toBe("VALIDATION");
    expect(await code(createChatImageUpload(alice, { name: "a.png", size: 0, type: "image/png" }, storage))).toBe("VALIDATION");
    expect(
      await code(createChatImageUpload(alice, { name: "a.png", size: CHAT_IMAGE_MAX_BYTES + 1, type: "image/png" }, storage)),
    ).toBe("VALIDATION");
    expect(await code(createChatImageUpload(alice, { name: "a.png", size: CHAT_IMAGE_MAX_BYTES, type: "image/png" }, storage))).toBe("OK");
  });
});

describe("chat photos: sending", () => {
  it("a message can be just a photo, and carries the image in its DTO", async () => {
    const file = await uploadPhoto(alice);
    expect(file.fromChat).toBe(true);
    const { message, created } = await sendChatMessage(alice, { body: "", fileId: file.id });
    expect(created).toBe(true);
    expect(message.body).toBe("");
    expect(message.image).toEqual({ id: file.id, name: "kedi.png", size: PNG.byteLength });
    expect((await getMessage(bob, message.id)).image?.id).toBe(file.id);
  });

  it("keeps the caption, and still rejects a message with neither text nor photo", async () => {
    const file = await uploadPhoto(alice);
    const { message } = await sendChatMessage(alice, { body: "  bakın  ", fileId: file.id });
    expect(message.body).toBe("bakın");
    expect(await code(sendChatMessage(alice, { body: "   " }))).toBe("VALIDATION");
  });

  it("a photo belongs to its uploader and to one message only", async () => {
    const file = await uploadPhoto(alice);
    expect(await code(sendChatMessage(bob, { body: "x", fileId: file.id }))).toBe("VALIDATION");
    expect(await code(sendChatMessage(other, { body: "x", fileId: file.id }))).toBe("VALIDATION");
    await sendChatMessage(alice, { body: "", fileId: file.id });
    expect(await code(sendChatMessage(alice, { body: "", fileId: file.id }))).toBe("CONFLICT");
    expect(await code(sendChatMessage(alice, { body: "", fileId: "yok-boyle-bir-dosya" }))).toBe("VALIDATION");
  });

  it("an ordinary Files-browser file cannot be attached to a message", async () => {
    const bytes = PNG;
    const row = await db.file.create({
      data: {
        workspaceId: alice.workspaceId,
        uploadedById: alice.userId,
        name: "normal.png",
        mimeType: "image/png",
        size: bytes.byteLength,
        storageKey: `${alice.workspaceId}/normal-${Date.now()}.png`,
      },
    });
    expect(await code(sendChatMessage(alice, { body: "", fileId: row.id }))).toBe("VALIDATION");
  });

  it("a retry with the same clientId returns the same photo message", async () => {
    const file = await uploadPhoto(alice);
    const first = await sendChatMessage(alice, { body: "", fileId: file.id, clientId: "photo-retry-0001" });
    const again = await sendChatMessage(alice, { body: "", fileId: file.id, clientId: "photo-retry-0001" });
    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
  });
});

describe("chat photos: not part of the Files browser", () => {
  it("chat photos are hidden from the folder listing and from recents", async () => {
    const file = await uploadPhoto(alice, "gizli-sohbet-fotosu.png");
    const root = await listFolderContents(alice, null);
    expect(root.files.map((f) => f.id)).not.toContain(file.id);
    const recent = await listRecentItems(alice, { take: 50 });
    expect(recent.map((r) => r.id)).not.toContain(file.id);
  });
});

describe("chat photos: deleting", () => {
  it("deleting the message removes the file row and its stored bytes", async () => {
    const file = await uploadPhoto(alice);
    const { message } = await sendChatMessage(alice, { body: "", fileId: file.id });
    expect(await storage.head(file.storageKey)).not.toBeNull();
    await deleteMessage(alice, message.id, storage);
    expect(await db.file.findUnique({ where: { id: file.id } })).toBeNull();
    expect(await storage.head(file.storageKey)).toBeNull();
  });
});
