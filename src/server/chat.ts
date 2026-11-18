import { Prisma } from "@prisma/client";
import { z } from "zod";

import { db } from "@/lib/db";
import { parseWorkspaceChannel } from "@/lib/pusher/channels";
import {
  CHAT_MAX_BODY,
  CHAT_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  type ChatCursor,
  type ChatMessageDTO,
} from "@/lib/pusher/chat-protocol";
import { canModify, isGuest } from "@/lib/roles";
import type { TenantContext } from "@/lib/tenant-context";
import { assertNotGuest } from "@/server/client-visibility";
import { forbidden, notFound, parseInput, ServiceError } from "@/server/errors";
import type { StorageDriver } from "@/lib/storage";
import { hardDeleteFile } from "@/server/files";

/**
 * Workspace chat ("Sohbet"): one room per workspace.
 * Every function takes the trusted TenantContext first and scopes every
 * query by ctx.workspaceId. Realtime fan-out is done by the caller (server
 * action) after these functions return, so this module stays pure + testable.
 */

const authorSelect = { id: true, name: true, email: true, image: true } as const;

const messageSelect = {
  id: true,
  body: true,
  createdAt: true,
  authorId: true,
  clientId: true,
  author: { select: authorSelect },
  file: { select: { id: true, name: true, size: true } },
} satisfies Prisma.ChatMessageSelect;

type MessageRow = Prisma.ChatMessageGetPayload<{ select: typeof messageSelect }>;

/**
 * `clientId` is only exposed to the message's own author (it lets their
 * browser reconcile an optimistic send whose response was lost).
 */
function toDTO(ctx: TenantContext, row: MessageRow): ChatMessageDTO {
  return {
    id: row.id,
    body: row.body,
    ...(row.file ? { image: { id: row.file.id, name: row.file.name, size: row.file.size } } : {}),
    createdAt: row.createdAt.toISOString(),
    authorId: row.authorId,
    author: row.author,
    cursor: encodeCursor(row.createdAt, row.id),
    ...(row.clientId && row.authorId === ctx.userId ? { clientId: row.clientId } : {}),
  };
}

/** Re-read the actor's membership so a stale or forged ctx is rejected. */
async function loadActor(ctx: TenantContext) {
  const actor = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
    select: { userId: true, role: true },
  });
  if (!actor) throw notFound("Çalışma alanı bulunamadı.");
  return actor;
}

function cursorOrThrow(raw: string): ChatCursor {
  const c = decodeCursor(raw);
  if (!c) throw new ServiceError("VALIDATION", "Geçersiz sayfa imleci.");
  return c;
}

/** Rows strictly before the cursor in (createdAt, id) order. */
function beforeCursor(c: ChatCursor): Prisma.ChatMessageWhereInput {
  return {
    OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }],
  };
}

/** Rows strictly after the cursor in (createdAt, id) order. */
function afterCursor(c: ChatCursor): Prisma.ChatMessageWhereInput {
  return {
    OR: [{ createdAt: { gt: c.createdAt } }, { createdAt: c.createdAt, id: { gt: c.id } }],
  };
}

/**
 * Which messages a conversation holds. Without a peer: the public room only
 * (never a direct message). With a peer: the direct messages between the
 * caller and that member, in either direction.
 */
function roomFilter(ctx: TenantContext, peerId?: string | null): Prisma.ChatMessageWhereInput {
  if (!peerId) return { workspaceId: ctx.workspaceId, recipientId: null };
  return {
    workspaceId: ctx.workspaceId,
    OR: [
      { authorId: ctx.userId, recipientId: peerId },
      { authorId: peerId, recipientId: ctx.userId },
    ],
  };
}

/** The chat is team-only: a guest gets FORBIDDEN from every chat service call. */
function assertChatAccess(ctx: TenantContext): void {
  assertNotGuest(ctx, "Sohbet yalnızca ekibe açıktır.");
}

/** A DM peer must be another current member (not a guest) of the workspace. */
async function assertPeer(ctx: TenantContext, peerId?: string | null): Promise<void> {
  if (!peerId) return;
  if (typeof peerId !== "string" || peerId.length > 64 || peerId === ctx.userId) {
    throw new ServiceError("VALIDATION", "Geçersiz alıcı.");
  }
  const m = await db.membership.findUnique({
    where: { userId_workspaceId: { userId: peerId, workspaceId: ctx.workspaceId } },
    select: { id: true, role: true },
  });
  // Guests are not in the chat: nobody can DM them either.
  if (!m || isGuest(m.role)) throw notFound("Üye bulunamadı.");
}

const NEWEST_FIRST = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.ChatMessageOrderByWithRelationInput[];
const OLDEST_FIRST = [{ createdAt: "asc" }, { id: "asc" }] satisfies Prisma.ChatMessageOrderByWithRelationInput[];

// ------------------------------------------------------------- reading ----

const listSchema = z.object({
  peer: z.string().max(64).optional(),
  before: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/**
 * A page of messages ending just before `before` (or the newest page).
 * Returned oldest-first, ready to render. `hasMore` = older messages exist.
 */
export async function listMessages(
  ctx: TenantContext,
  input: { before?: string; limit?: number; peer?: string } = {},
): Promise<{ messages: ChatMessageDTO[]; hasMore: boolean }> {
  assertChatAccess(ctx);
  const { before, limit = CHAT_PAGE_SIZE, peer } = parseInput(listSchema, input);
  await assertPeer(ctx, peer);
  const where: Prisma.ChatMessageWhereInput = {
    AND: [roomFilter(ctx, peer), ...(before ? [beforeCursor(cursorOrThrow(before))] : [])],
  };

  const rows = await db.chatMessage.findMany({
    where,
    orderBy: NEWEST_FIRST,
    take: limit + 1,
    select: messageSelect,
  });
  const hasMore = rows.length > limit;
  return { messages: rows.slice(0, limit).reverse().map((r) => toDTO(ctx, r)), hasMore };
}

const afterSchema = z.object({
  peer: z.string().max(64).optional(),
  after: z.string().max(100),
  limit: z.number().int().min(1).max(200).optional(),
});

/** Messages strictly newer than `after`, oldest-first (polling + resync). */
export async function listMessagesAfter(
  ctx: TenantContext,
  input: { after: string; limit?: number; peer?: string },
): Promise<ChatMessageDTO[]> {
  return (await listMessagesAfterPage(ctx, input)).messages;
}

/**
 * Same as listMessagesAfter, plus `hasMoreAfter` when the page was cut at
 * `limit`, so a resync after a long disconnect can keep paging instead of
 * leaving a silent gap.
 */
export async function listMessagesAfterPage(
  ctx: TenantContext,
  input: { after: string; limit?: number; peer?: string },
): Promise<{ messages: ChatMessageDTO[]; hasMoreAfter: boolean }> {
  assertChatAccess(ctx);
  const { after, limit = 100, peer } = parseInput(afterSchema, input);
  await assertPeer(ctx, peer);
  const rows = await db.chatMessage.findMany({
    where: { AND: [roomFilter(ctx, peer), afterCursor(cursorOrThrow(after))] },
    orderBy: OLDEST_FIRST,
    take: limit + 1,
    select: messageSelect,
  });
  return { messages: rows.slice(0, limit).map((r) => toDTO(ctx, r)), hasMoreAfter: rows.length > limit };
}

export const LIVE_IDS_CAP = 300;

/**
 * Ids of all messages at or after `from` (newest first, capped). Polling
 * clients diff this against what they show to drop deleted messages.
 */
export async function listLiveIdsFrom(
  ctx: TenantContext,
  from: string,
  peer?: string,
): Promise<{ ids: string[]; complete: boolean }> {
  assertChatAccess(ctx);
  const c = cursorOrThrow(from);
  await assertPeer(ctx, peer);
  const rows = await db.chatMessage.findMany({
    where: {
      AND: [
        roomFilter(ctx, peer),
        { OR: [{ createdAt: { gt: c.createdAt } }, { createdAt: c.createdAt, id: { gte: c.id } }] },
      ],
    },
    orderBy: NEWEST_FIRST,
    take: LIVE_IDS_CAP + 1,
    select: { id: true },
  });
  return {
    ids: rows.slice(0, LIVE_IDS_CAP).map((r) => r.id),
    complete: rows.length <= LIVE_IDS_CAP,
  };
}

/** One message of this workspace (NOT_FOUND for other workspaces' ids). */
export async function getMessage(ctx: TenantContext, id: string): Promise<ChatMessageDTO> {
  assertChatAccess(ctx);
  if (typeof id !== "string" || id.length === 0 || id.length > 64) throw notFound("Mesaj bulunamadı.");
  const row = await db.chatMessage.findFirst({
    where: {
      id,
      workspaceId: ctx.workspaceId,
      OR: [{ recipientId: null }, { authorId: ctx.userId }, { recipientId: ctx.userId }],
    },
    select: messageSelect,
  });
  if (!row) throw notFound("Mesaj bulunamadı.");
  return toDTO(ctx, row);
}

// ------------------------------------------------------------- writing ----

/**
 * Shape of the browser-generated send id (crypto.randomUUID() or the
 * timestamp/random fallback in use-chat-feed). Bounded so it cannot be used to
 * stuff arbitrary data into the unique index.
 */
export const CHAT_CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const createSchema = z
  .object({
  // May be empty when a photo is attached (checked below).
  body: z
    .string({ error: "Mesaj boş olamaz." })
    .trim()
    .max(CHAT_MAX_BODY, { error: `Mesaj en fazla ${CHAT_MAX_BODY} karakter olabilir.` }),
  fileId: z.string().min(1).max(64).optional(),
  peerId: z.string().min(1).max(64).optional(),
  clientId: z
    .string({ error: "Geçersiz mesaj kimliği." })
    .regex(CHAT_CLIENT_ID_PATTERN, { error: "Geçersiz mesaj kimliği." })
    .optional(),
  })
  .refine((v) => v.body.length > 0 || v.fileId, { error: "Mesaj boş olamaz.", path: ["body"] });

type CreateInput = { body: unknown; clientId?: unknown; fileId?: unknown; peerId?: unknown };

/** Result of an idempotent send: `created` is false when a retry hit an existing row. */
export type SendResult = { message: ChatMessageDTO; created: boolean };

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/**
 * A message may only carry a photo this same user uploaded for chat in this
 * workspace (File.fromChat) that no other message uses yet.
 */
async function assertOwnChatPhoto(client: Client, ctx: TenantContext, fileId: string): Promise<void> {
  const file = await client.file.findFirst({
    where: { id: fileId, workspaceId: ctx.workspaceId, uploadedById: ctx.userId, fromChat: true },
    select: { id: true, chatMessage: { select: { id: true } } },
  });
  if (!file) throw new ServiceError("VALIDATION", "Fotoğraf bulunamadı. Lütfen yeniden yükleyin.");
  if (file.chatMessage) throw new ServiceError("CONFLICT", "Bu fotoğraf zaten bir mesajda kullanıldı.");
}

/**
 * The message this author already stored under `clientId` in this workspace,
 * or null. A different body under the same clientId is a client bug or a
 * forged request, not a retry, so it is refused instead of silently returning
 * someone's earlier text.
 */
async function findByClientId(
  client: Client,
  ctx: TenantContext,
  clientId: string,
  body: string,
  fileId?: string,
): Promise<ChatMessageDTO | null> {
  const row = await client.chatMessage.findFirst({
    where: { workspaceId: ctx.workspaceId, authorId: ctx.userId, clientId },
    select: messageSelect,
  });
  if (!row) return null;
  if (row.body !== body || (row.file?.id ?? undefined) !== fileId) {
    throw new ServiceError("CONFLICT", "Bu mesaj kimliği farklı bir mesaj için zaten kullanıldı.");
  }
  return toDTO(ctx, row);
}

/**
 * Any member can post. Body is trimmed; empty or over 4000 chars is rejected.
 * With a `clientId` the call is idempotent per (workspace, author, clientId):
 * a repeat returns the stored message instead of inserting a duplicate.
 */
export async function createMessage(ctx: TenantContext, input: CreateInput): Promise<ChatMessageDTO> {
  return (await createMessageIdempotent(ctx, input)).message;
}

/** createMessage plus whether a row was actually inserted. */
export async function createMessageIdempotent(ctx: TenantContext, input: CreateInput): Promise<SendResult> {
  assertChatAccess(ctx);
  const { body, clientId, fileId, peerId } = parseInput(createSchema, input);
  const actor = await loadActor(ctx);
  await assertPeer(ctx, peerId);
  if (clientId) {
    const existing = await findByClientId(db, ctx, clientId, body, fileId);
    if (existing) return { message: existing, created: false };
  }
  try {
    if (fileId) await assertOwnChatPhoto(db, ctx, fileId);
    const row = await db.chatMessage.create({
      data: {
        workspaceId: ctx.workspaceId,
        authorId: actor.userId,
        body,
        clientId: clientId ?? null,
        fileId: fileId ?? null,
        recipientId: peerId ?? null,
      },
      select: messageSelect,
    });
    return { message: toDTO(ctx, row), created: true };
  } catch (e) {
    // A concurrent retry inserted the same clientId first: return its row.
    if (clientId && isUniqueViolation(e)) {
      const existing = await findByClientId(db, ctx, clientId, body, fileId);
      if (existing) return { message: existing, created: false };
    }
    throw e;
  }
}

/** Flood guard: at most CHAT_RATE_LIMIT messages per user per window. */
export const CHAT_RATE_LIMIT = 15;
export const CHAT_RATE_WINDOW_MS = 10_000;

type Client = typeof db | Prisma.TransactionClient;

/**
 * Throws CONFLICT when the user has sent too many messages in this workspace
 * within the window. Kept separate from createMessage so tests that seed many
 * messages are not throttled; the send path uses sendRateLimitedMessage.
 */
export async function assertChatRateLimit(
  ctx: TenantContext,
  now: Date = new Date(),
  client: Client = db,
): Promise<void> {
  const recent = await client.chatMessage.count({
    where: {
      workspaceId: ctx.workspaceId,
      authorId: ctx.userId,
      createdAt: { gt: new Date(now.getTime() - CHAT_RATE_WINDOW_MS) },
    },
  });
  if (recent >= CHAT_RATE_LIMIT) {
    throw new ServiceError("CONFLICT", "Çok hızlı mesaj gönderiyorsunuz. Birkaç saniye bekleyip tekrar deneyin.");
  }
}

/**
 * Rate check + insert as one unit: a per-(workspace, user) advisory lock
 * serialises concurrent sends, so a parallel burst cannot all pass the count
 * before any insert commits. Realtime fan-out stays with the caller, after commit.
 */
export async function sendRateLimitedMessage(ctx: TenantContext, input: CreateInput): Promise<ChatMessageDTO> {
  return (await sendChatMessage(ctx, input)).message;
}

/**
 * The send path used by the server action. Idempotent on clientId: a retry
 * (e.g. after a lost response) is answered with the stored row BEFORE the
 * rate check, so it neither counts against the limit again nor inserts a
 * duplicate. `created` tells the caller whether to publish a realtime event.
 * The advisory lock already serialises one user's sends; the unique index
 * (workspaceId, authorId, clientId) is the backstop if anything bypasses it.
 */
export async function sendChatMessage(ctx: TenantContext, input: CreateInput): Promise<SendResult> {
  assertChatAccess(ctx);
  const { body, clientId, fileId, peerId } = parseInput(createSchema, input);
  await assertPeer(ctx, peerId);
  try {
    return await db.$transaction(async (tx): Promise<SendResult> => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"hestia:chat-rate:" + ctx.workspaceId + ":" + ctx.userId}))`;
      const actor = await tx.membership.findUnique({
        where: { userId_workspaceId: { userId: ctx.userId, workspaceId: ctx.workspaceId } },
        select: { userId: true },
      });
      if (!actor) throw notFound("Çalışma alanı bulunamadı.");
      if (clientId) {
        const existing = await findByClientId(tx, ctx, clientId, body, fileId);
        if (existing) return { message: existing, created: false };
      }
      await assertChatRateLimit(ctx, new Date(), tx);
      if (fileId) await assertOwnChatPhoto(tx, ctx, fileId);
      const row = await tx.chatMessage.create({
        data: {
          workspaceId: ctx.workspaceId,
          authorId: actor.userId,
          body,
          clientId: clientId ?? null,
          fileId: fileId ?? null,
          recipientId: peerId ?? null,
        },
        select: messageSelect,
      });
      return { message: toDTO(ctx, row), created: true };
    });
  } catch (e) {
    // The failed insert aborted the transaction; read the winner outside it.
    if (clientId && isUniqueViolation(e)) {
      await loadActor(ctx);
      const existing = await findByClientId(db, ctx, clientId, body, fileId);
      if (existing) return { message: existing, created: false };
    }
    throw e;
  }
}

/** Authors delete their own messages; ADMIN/OWNER delete any. */
export async function deleteMessage(
  ctx: TenantContext,
  id: string,
  storage?: StorageDriver,
): Promise<{ id: string }> {
  assertChatAccess(ctx);
  if (typeof id !== "string" || id.length === 0 || id.length > 64) throw notFound("Mesaj bulunamadı.");
  const actor = await loadActor(ctx);
  const msg = await db.chatMessage.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
    select: { id: true, authorId: true, fileId: true, recipientId: true },
  });
  // A direct message is invisible to everyone but its two people.
  if (msg?.recipientId && msg.authorId !== actor.userId && msg.recipientId !== actor.userId) {
    throw notFound("Mesaj bulunamadı.");
  }
  if (!msg) throw notFound("Mesaj bulunamadı.");
  // Admins moderate the public room only; a DM can be deleted by its author alone.
  if (msg.recipientId ? msg.authorId !== actor.userId : !canModify({ userId: actor.userId, role: actor.role }, msg.authorId)) {
    throw forbidden("Yalnızca kendi mesajlarınızı silebilirsiniz.");
  }
  // Scoped again by workspaceId so the write can never touch another tenant.
  const res = await db.chatMessage.deleteMany({ where: { id: msg.id, workspaceId: ctx.workspaceId } });
  if (res.count === 0) throw notFound("Mesaj bulunamadı.");
  // The photo goes with its message (row + stored bytes). Never fails the delete.
  if (msg.fileId) {
    try {
      await hardDeleteFile(ctx, msg.fileId, storage);
    } catch (e) {
      console.error("[chat] could not delete message photo:", e instanceof Error ? e.message : e);
    }
  }
  return { id: msg.id };
}

// ------------------------------------------------- channel authorisation ----

export type ChannelAuthDecision =
  | { allow: true; workspaceId: string }
  | { allow: false; reason: "MALFORMED_CHANNEL" | "NOT_A_MEMBER" | "NO_USER" };

/**
 * Decides whether `userId` may subscribe to `channelName`. The only channel
 * shape accepted is "private-workspace-<workspaceId>", and only for members
 * of that exact workspace (checked in the DB). Exception to the ctx-first
 * rule: there is no workspace context yet, it is what is being decided.
 */
export async function authorizeChatChannel(
  userId: string | null | undefined,
  channelName: unknown,
): Promise<ChannelAuthDecision> {
  if (typeof userId !== "string" || userId.length === 0) return { allow: false, reason: "NO_USER" };
  const workspaceId = parseWorkspaceChannel(channelName);
  if (!workspaceId) return { allow: false, reason: "MALFORMED_CHANNEL" };
  const membership = await db.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId } },
    select: { id: true, role: true },
  });
  // Guests never join the chat channel.
  if (!membership || isGuest(membership.role)) return { allow: false, reason: "NOT_A_MEMBER" };
  return { allow: true, workspaceId };
}

// ------------------------------------------------------ conversations ----

export type ConversationDTO = {
  userId: string;
  name: string | null;
  email: string;
  image: string | null;
  isBot: boolean;
  lastAt: string | null;
  lastText: string | null;
  unread: boolean;
};

/** The other members as DM partners, most recent conversation first. */
export async function listConversations(ctx: TenantContext): Promise<ConversationDTO[]> {
  assertChatAccess(ctx);
  const [members, recent, unread] = await Promise.all([
    db.membership.findMany({
      where: { workspaceId: ctx.workspaceId, userId: { not: ctx.userId }, role: { not: "GUEST" } },
      select: { user: { select: authorSelect } },
    }),
    db.chatMessage.findMany({
      where: {
        workspaceId: ctx.workspaceId,
        OR: [{ authorId: ctx.userId, recipientId: { not: null } }, { recipientId: ctx.userId }],
      },
      orderBy: NEWEST_FIRST,
      take: 300,
      select: { authorId: true, recipientId: true, body: true, createdAt: true, fileId: true },
    }),
    db.notification.findMany({
      where: { workspaceId: ctx.workspaceId, userId: ctx.userId, type: "CHAT_DM", readAt: null },
      select: { path: true },
    }),
  ]);
  const last = new Map<string, (typeof recent)[number]>();
  for (const m of recent) {
    const other = m.authorId === ctx.userId ? m.recipientId : m.authorId;
    if (other && !last.has(other)) last.set(other, m);
  }
  const unreadPeers = new Set(unread.map((n) => n.path.replace("chat?with=", "")));
  const out = members.map(({ user }): ConversationDTO => {
    const l = last.get(user.id);
    return {
      userId: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      isBot: user.id === "claude-bot",
      lastAt: l ? l.createdAt.toISOString() : null,
      lastText: l ? (l.body || (l.fileId ? "📷 Fotoğraf" : "")).slice(0, 80) : null,
      unread: unreadPeers.has(user.id),
    };
  });
  return out.sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || (a.name ?? a.email).localeCompare(b.name ?? b.email));
}

/** The peer's public profile, for the conversation header (null if not a member). */
export async function getPeer(ctx: TenantContext, peerId: string) {
  assertChatAccess(ctx);
  await assertPeer(ctx, peerId);
  return db.user.findUnique({ where: { id: peerId }, select: authorSelect });
}
