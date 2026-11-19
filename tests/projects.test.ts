import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { createEvent } from "@/server/calendar";
import { createFolder, moveFolder } from "@/server/files";
import { createPost, listPosts, publishPost } from "@/server/messages";
import {
  archiveProject,
  createProject,
  getProject,
  getProjectOverview,
  listProjectOptions,
  listProjects,
  renameProject,
  setItemProject,
} from "@/server/projects";
import { createTodoList, listTodoLists } from "@/server/todos";

import { cleanup, createMember, createTestUser, createTestWorkspace } from "./helpers";

afterAll(async () => {
  await cleanup();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code?: string }).code ?? "OTHER";
  }
  return "OK";
}

async function setup() {
  const owner = await createTestUser();
  const { workspace, ctx } = await createTestWorkspace(owner.id);
  const { ctx: admin } = await createMember(workspace.id, "ADMIN");
  const { ctx: member } = await createMember(workspace.id, "MEMBER");
  const { ctx: member2 } = await createMember(workspace.id, "MEMBER");
  return { workspace, owner: ctx, admin, member, member2 };
}

const event = (extra: Record<string, unknown> = {}) => ({
  title: "Toplantı",
  startsAt: "2030-01-10T10:00",
  endsAt: "2030-01-10T11:00",
  ...extra,
});

describe("proje CRUD ve roller", () => {
  it("OWNER ve ADMIN proje oluşturur, MEMBER oluşturamaz", async () => {
    const { owner, admin, member } = await setup();
    const p = await createProject(owner, { name: "  Web Sitesi  ", description: "Yeni site" });
    expect(p.name).toBe("Web Sitesi");
    expect(p.slug).toBe("web-sitesi");
    expect(p.archived).toBe(false);
    expect(p.description).toBe("Yeni site");
    const p2 = await createProject(admin, { name: "Mobil" });
    expect(p2.description).toBeNull();
    expect(p2.position).toBe(p.position + 1);
    expect(await code(createProject(member, { name: "Olmaz" }))).toBe("FORBIDDEN");
  });

  it("adı doğrular", async () => {
    const { owner } = await setup();
    expect(await code(createProject(owner, { name: "   " }))).toBe("VALIDATION");
    expect(await code(createProject(owner, { name: "x".repeat(81) }))).toBe("VALIDATION");
    expect(await code(createProject(owner, {}))).toBe("VALIDATION");
  });

  it("slug alan içinde benzersizdir (çakışmada -2, -3), alanlar arasında aynı olabilir", async () => {
    const a = await setup();
    const b = await setup();
    const p1 = await createProject(a.owner, { name: "Pazarlama" });
    const p2 = await createProject(a.owner, { name: "Pazarlama" });
    const p3 = await createProject(a.owner, { name: "pazarlama" });
    expect([p1.slug, p2.slug, p3.slug]).toEqual(["pazarlama", "pazarlama-2", "pazarlama-3"]);
    const other = await createProject(b.owner, { name: "Pazarlama" });
    expect(other.slug).toBe("pazarlama");
    const rows = await db.project.findMany({ where: { workspaceId: a.workspace.id } });
    expect(new Set(rows.map((r) => r.slug)).size).toBe(3);
  });

  it("yalnızca sembollerden oluşan ad için varsayılan slug kullanır; Türkçe karakterleri çevirir", async () => {
    const { owner } = await setup();
    expect((await createProject(owner, { name: "!!!" })).slug).toBe("proje");
    expect((await createProject(owner, { name: "Çağrı Şirketi İşleri" })).slug).toBe("cagri-sirketi-isleri");
  });

  it("eşzamanlı oluşturmada slug çakışmaz", async () => {
    const { owner } = await setup();
    const made = await Promise.all(Array.from({ length: 5 }, () => createProject(owner, { name: "Aynı" })));
    expect(new Set(made.map((p) => p.slug)).size).toBe(5);
  });

  it("yeniden adlandırma slug'ı değiştirmez; açıklama güncellenir/temizlenir", async () => {
    const { owner, admin, member } = await setup();
    const p = await createProject(owner, { name: "Eski", description: "a" });
    const r = await renameProject(admin, p.id, { name: "Yeni ad" });
    expect(r.name).toBe("Yeni ad");
    expect(r.slug).toBe("eski");
    expect(r.description).toBe("a");
    expect((await renameProject(owner, p.id, { description: "" })).description).toBeNull();
    expect(await code(renameProject(member, p.id, { name: "Hack" }))).toBe("FORBIDDEN");
    expect(await code(renameProject(owner, p.id, { name: "" }))).toBe("VALIDATION");
    expect(await code(renameProject(owner, "yok", { name: "x" }))).toBe("NOT_FOUND");
  });

  it("arşivleme ve geri alma yalnızca ADMIN+; listProjects aktif/arşiv ayırır", async () => {
    const { owner, admin, member } = await setup();
    const a = await createProject(owner, { name: "A" });
    const b = await createProject(owner, { name: "B" });
    const c = await createProject(owner, { name: "C" });
    expect(await code(archiveProject(member, b.id))).toBe("FORBIDDEN");
    expect((await archiveProject(admin, b.id)).archived).toBe(true);
    const lists = await listProjects(member);
    expect(lists.active.map((p) => p.id)).toEqual([a.id, c.id]);
    expect(lists.archived.map((p) => p.id)).toEqual([b.id]);
    expect((await listProjectOptions(member)).map((p) => p.id)).toEqual([a.id, c.id]);
    expect((await archiveProject(owner, b.id, false)).archived).toBe(false);
    expect((await listProjects(owner)).archived).toEqual([]);
    expect(await code(archiveProject(owner, "yok"))).toBe("NOT_FOUND");
  });

  it("getProject slug ile bulur; bilinmeyen slug NOT_FOUND; her rol okuyabilir", async () => {
    const { owner, member } = await setup();
    const p = await createProject(owner, { name: "Okunur" });
    expect((await getProject(member, "okunur")).id).toBe(p.id);
    expect(await code(getProject(member, "yok"))).toBe("NOT_FOUND");
  });
});

describe("öğeleri projeye atama", () => {
  it("mesaj, liste, klasör ve etkinlik projeye atanır; boş değer Genel demektir", async () => {
    const { owner, member } = await setup();
    const p = await createProject(owner, { name: "Proje" });
    const post = await createPost(member, { title: "T", body: "B", projectId: p.id });
    const list = await createTodoList(member, { name: "L", projectId: p.id });
    const folder = await createFolder(member, { name: "K", projectId: p.id });
    const ev = await createEvent(member, event({ projectId: p.id }));
    expect([post.projectId, list.projectId, folder.projectId, ev.projectId]).toEqual([p.id, p.id, p.id, p.id]);

    const post2 = await createPost(member, { title: "T2", body: "B", projectId: "" });
    const list2 = await createTodoList(member, { name: "L2" });
    const folder2 = await createFolder(member, { name: "K2", projectId: null });
    const ev2 = await createEvent(member, event());
    expect([post2.projectId, list2.projectId, folder2.projectId, ev2.projectId]).toEqual([null, null, null, null]);
  });

  it("başka alanın, olmayan ya da arşivli projeye atamayı reddeder", async () => {
    const a = await setup();
    const b = await setup();
    const foreign = await createProject(b.owner, { name: "Yabancı" });
    const archived = await createProject(a.owner, { name: "Arşiv" });
    await archiveProject(a.owner, archived.id);
    for (const projectId of [foreign.id, "olmayan-id", archived.id]) {
      expect(await code(createPost(a.member, { title: "T", body: "B", projectId }))).toBe("VALIDATION");
      expect(await code(createTodoList(a.member, { name: "L", projectId }))).toBe("VALIDATION");
      expect(await code(createFolder(a.member, { name: "K", projectId }))).toBe("VALIDATION");
      expect(await code(createEvent(a.member, event({ projectId })))).toBe("VALIDATION");
    }
    expect(await db.post.count({ where: { workspaceId: a.workspace.id } })).toBe(0);
    expect(await db.todoList.count({ where: { workspaceId: a.workspace.id } })).toBe(0);
    expect(await db.folder.count({ where: { workspaceId: a.workspace.id } })).toBe(0);
    expect(await db.event.count({ where: { workspaceId: a.workspace.id } })).toBe(0);
  });

  it("alt klasör üst klasörün projesini devralır", async () => {
    const { owner, member } = await setup();
    const p = await createProject(owner, { name: "Proje" });
    const q = await createProject(owner, { name: "Diğer" });
    const root = await createFolder(member, { name: "Kök", projectId: p.id });
    const child = await createFolder(member, { name: "Alt", parentId: root.id, projectId: q.id });
    expect(child.projectId).toBe(p.id);
    const plainRoot = await createFolder(member, { name: "Düz" });
    const plainChild = await createFolder(member, { name: "Alt", parentId: plainRoot.id, projectId: q.id });
    expect(plainChild.projectId).toBeNull();
  });

  it("proje silinirse içerik Genel'e döner (SetNull)", async () => {
    const { owner, member, workspace } = await setup();
    const p = await createProject(owner, { name: "Silinecek" });
    const post = await createPost(member, { title: "T", body: "B", projectId: p.id });
    await db.project.delete({ where: { id: p.id } });
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).projectId).toBeNull();
    expect(await db.post.count({ where: { workspaceId: workspace.id } })).toBe(1);
  });
});

describe("setItemProject", () => {
  it("yazar ya da ADMIN+ taşır, başka üye taşıyamaz; null Genel'e döndürür", async () => {
    const { owner, admin, member, member2 } = await setup();
    const p = await createProject(owner, { name: "Hedef" });
    const post = await createPost(member, { title: "T", body: "B" });
    const list = await createTodoList(member, { name: "L" });
    const ev = await createEvent(member, event());
    const folder = await createFolder(member, { name: "K" });
    for (const [kind, id] of [
      ["post", post.id],
      ["todoList", list.id],
      ["event", ev.id],
      ["folder", folder.id],
    ] as const) {
      expect(await code(setItemProject(member2, kind, id, p.id))).toBe("FORBIDDEN");
      await setItemProject(member, kind, id, p.id);
      await setItemProject(admin, kind, id, null);
      await setItemProject(owner, kind, id, p.id);
    }
    expect((await db.post.findUniqueOrThrow({ where: { id: post.id } })).projectId).toBe(p.id);
    expect((await db.todoList.findUniqueOrThrow({ where: { id: list.id } })).projectId).toBe(p.id);
    expect((await db.event.findUniqueOrThrow({ where: { id: ev.id } })).projectId).toBe(p.id);
    expect((await db.folder.findUniqueOrThrow({ where: { id: folder.id } })).projectId).toBe(p.id);
  });

  it("klasör taşınınca alt klasörler de gelir; alt klasör tek başına atanamaz", async () => {
    const { owner, member } = await setup();
    const p = await createProject(owner, { name: "Hedef" });
    const root = await createFolder(member, { name: "Kök" });
    const child = await createFolder(member, { name: "Alt", parentId: root.id });
    const grand = await createFolder(member, { name: "Torun", parentId: child.id });
    expect(await code(setItemProject(member, "folder", child.id, p.id))).toBe("VALIDATION");
    await setItemProject(member, "folder", root.id, p.id);
    for (const f of [root, child, grand]) {
      expect((await db.folder.findUniqueOrThrow({ where: { id: f.id } })).projectId).toBe(p.id);
    }
  });

  it("alan yalıtımı, arşivli hedef, olmayan öğe ve çöpteki öğe reddedilir", async () => {
    const a = await setup();
    const b = await setup();
    const pa = await createProject(a.owner, { name: "A" });
    const pb = await createProject(b.owner, { name: "B" });
    const postB = await createPost(b.member, { title: "T", body: "B" });
    const postA = await createPost(a.member, { title: "T", body: "B" });
    expect(await code(setItemProject(a.owner, "post", postB.id, pa.id))).toBe("NOT_FOUND");
    expect(await code(setItemProject(a.owner, "post", postA.id, pb.id))).toBe("VALIDATION");
    expect(await code(setItemProject(a.owner, "post", "yok", pa.id))).toBe("NOT_FOUND");
    await archiveProject(a.owner, pa.id);
    expect(await code(setItemProject(a.owner, "post", postA.id, pa.id))).toBe("VALIDATION");
    await db.post.update({ where: { id: postA.id }, data: { deletedAt: new Date() } });
    expect(await code(setItemProject(a.owner, "post", postA.id, null))).toBe("NOT_FOUND");
  });

  it("başkasının taslağı atanamaz (yönetici dahil görünmez)", async () => {
    const { owner, admin, member } = await setup();
    const p = await createProject(owner, { name: "P" });
    const draft = await createPost(member, { title: "Taslak", body: "B", draft: true });
    expect(await code(setItemProject(admin, "post", draft.id, p.id))).toBe("NOT_FOUND");
    await setItemProject(member, "post", draft.id, p.id);
    expect((await db.post.findUniqueOrThrow({ where: { id: draft.id } })).projectId).toBe(p.id);
  });
});

describe("proje görünümü ve çalışma alanı listeleri", () => {
  it("proje görünümü yalnızca o projenin öğelerini gösterir; alan geneli listeler hepsini", async () => {
    const { owner, member } = await setup();
    const p = await createProject(owner, { name: "Birinci" });
    const q = await createProject(owner, { name: "İkinci" });

    const inP = await createPost(member, { title: "P mesajı", body: "B", projectId: p.id });
    const inQ = await createPost(member, { title: "Q mesajı", body: "B", projectId: q.id });
    const gen = await createPost(member, { title: "Genel mesaj", body: "B" });
    const listP = await createTodoList(member, { name: "P listesi", projectId: p.id });
    const listQ = await createTodoList(member, { name: "Q listesi", projectId: q.id });
    const listG = await createTodoList(member, { name: "Genel liste" });
    const fP = await createFolder(member, { name: "P klasörü", projectId: p.id });
    const fQ = await createFolder(member, { name: "Q klasörü", projectId: q.id });
    const fG = await createFolder(member, { name: "Genel klasör" });
    const evP = await createEvent(member, event({ title: "P etkinliği", projectId: p.id }));
    const evQ = await createEvent(member, event({ title: "Q etkinliği", projectId: q.id }));
    const evG = await createEvent(member, event({ title: "Genel etkinlik" }));

    const ov = await getProjectOverview(member, "birinci");
    expect(ov.posts.map((x) => x.id)).toEqual([inP.id]);
    expect(ov.todoLists.map((x) => x.id)).toEqual([listP.id]);
    expect(ov.folders.map((x) => x.id)).toEqual([fP.id]);
    expect(ov.events.map((x) => x.id)).toEqual([evP.id]);
    expect(ov.counts).toEqual({ posts: 1, todoLists: 1, folders: 1, events: 1 });

    const ovQ = await getProjectOverview(owner, "ikinci");
    expect(ovQ.posts.map((x) => x.id)).toEqual([inQ.id]);
    expect(ovQ.todoLists.map((x) => x.id)).toEqual([listQ.id]);
    expect(ovQ.folders.map((x) => x.id)).toEqual([fQ.id]);
    expect(ovQ.events.map((x) => x.id)).toEqual([evQ.id]);

    // Workspace-wide listings are unfiltered: null + every project.
    const posts = await listPosts(member);
    expect(posts.items.map((x) => x.id).sort()).toEqual([inP.id, inQ.id, gen.id].sort());
    const lists = await listTodoLists(member);
    expect(lists.map((x) => x.id).sort()).toEqual([listP.id, listQ.id, listG.id].sort());
    const folders = await db.folder.findMany({ where: { workspaceId: member.workspaceId, deletedAt: null } });
    expect(folders.map((x) => x.id).sort()).toEqual([fP.id, fQ.id, fG.id].sort());
    const events = await db.event.findMany({ where: { workspaceId: member.workspaceId } });
    expect(events.map((x) => x.id).sort()).toEqual([evP.id, evQ.id, evG.id].sort());
  });

  it("silinmiş (çöp) öğeler proje görünümünde ve sayımlarda yer almaz", async () => {
    const { owner, member } = await setup();
    const p = await createProject(owner, { name: "Çöp" });
    const post = await createPost(member, { title: "P", body: "B", projectId: p.id });
    const list = await createTodoList(member, { name: "L", projectId: p.id });
    const folder = await createFolder(member, { name: "K", projectId: p.id });
    const ev = await createEvent(member, event({ projectId: p.id }));
    const keep = await createPost(member, { title: "Kalan", body: "B", projectId: p.id });
    const now = new Date();
    await db.post.update({ where: { id: post.id }, data: { deletedAt: now } });
    await db.todoList.update({ where: { id: list.id }, data: { deletedAt: now } });
    await db.folder.update({ where: { id: folder.id }, data: { deletedAt: now } });
    await db.event.update({ where: { id: ev.id }, data: { deletedAt: now } });
    const ov = await getProjectOverview(member, "cop");
    expect(ov.posts.map((x) => x.id)).toEqual([keep.id]);
    expect(ov.todoLists).toEqual([]);
    expect(ov.folders).toEqual([]);
    expect(ov.events).toEqual([]);
    expect(ov.counts).toEqual({ posts: 1, todoLists: 0, folders: 0, events: 0 });
  });

  it("taslaklar yalnızca yazarına görünür; yayınlanınca herkese", async () => {
    const { owner, member, member2 } = await setup();
    const p = await createProject(owner, { name: "Taslaklı" });
    const draft = await createPost(member, { title: "Taslak", body: "B", draft: true, projectId: p.id });
    const pub = await createPost(member, { title: "Yayın", body: "B", projectId: p.id });
    expect((await getProjectOverview(member, "taslakli")).posts.map((x) => x.id).sort()).toEqual([draft.id, pub.id].sort());
    expect((await getProjectOverview(member, "taslakli")).posts.find((x) => x.id === draft.id)?.isDraft).toBe(true);
    for (const viewer of [member2, owner]) {
      const ov = await getProjectOverview(viewer, "taslakli");
      expect(ov.posts.map((x) => x.id)).toEqual([pub.id]);
      expect(ov.counts.posts).toBe(1);
    }
    await publishPost(member, draft.id);
    expect((await getProjectOverview(member2, "taslakli")).counts.posts).toBe(2);
  });

  it("liste ilerlemesi yalnızca silinmemiş maddeleri sayar", async () => {
    const { owner, member, workspace } = await setup();
    const p = await createProject(owner, { name: "İlerleme" });
    const list = await createTodoList(member, { name: "L", projectId: p.id });
    const mk = (title: string, status: "OPEN" | "DONE", deletedAt: Date | null = null) =>
      db.todoItem.create({
        data: { workspaceId: workspace.id, listId: list.id, createdById: member.userId, title, status, deletedAt },
      });
    await mk("a", "OPEN");
    await mk("b", "DONE");
    await mk("c", "DONE", new Date());
    const ov = await getProjectOverview(member, "ilerleme");
    expect(ov.todoLists[0]).toMatchObject({ total: 2, done: 1 });
  });

  it("alt klasörler kök klasör listesinde görünmez ama sayılmaz", async () => {
    const { owner, member } = await setup();
    const p = await createProject(owner, { name: "Dosyalı" });
    const root = await createFolder(member, { name: "Kök", projectId: p.id });
    await createFolder(member, { name: "Alt", parentId: root.id });
    const ov = await getProjectOverview(member, "dosyali");
    expect(ov.folders.map((x) => x.id)).toEqual([root.id]);
    expect(ov.counts.folders).toBe(1);
  });

  it("arşivli proje görünümü hâlâ okunabilir", async () => {
    const { owner, member } = await setup();
    const p = await createProject(owner, { name: "Eski" });
    const post = await createPost(member, { title: "P", body: "B", projectId: p.id });
    await archiveProject(owner, p.id);
    const ov = await getProjectOverview(member, "eski");
    expect(ov.project.archived).toBe(true);
    expect(ov.posts.map((x) => x.id)).toEqual([post.id]);
  });

  it("çalışma alanı yalıtımı: başka alanın projesi görünmez, listelenmez", async () => {
    const a = await setup();
    const b = await setup();
    const pb = await createProject(b.owner, { name: "Gizli" });
    await createPost(b.member, { title: "Gizli mesaj", body: "B", projectId: pb.id });
    expect(await code(getProjectOverview(a.owner, "gizli"))).toBe("NOT_FOUND");
    expect(await code(getProject(a.owner, "gizli"))).toBe("NOT_FOUND");
    expect(await code(renameProject(a.owner, pb.id, { name: "Ele geçir" }))).toBe("NOT_FOUND");
    expect(await code(archiveProject(a.owner, pb.id))).toBe("NOT_FOUND");
    expect((await listProjects(a.owner)).active).toEqual([]);
    expect((await listProjectOptions(a.owner))).toEqual([]);
    expect((await db.project.findUniqueOrThrow({ where: { id: pb.id } })).name).toBe("Gizli");
    // Same slug in each workspace resolves to its own project.
    const pa = await createProject(a.owner, { name: "Gizli" });
    expect((await getProject(a.owner, "gizli")).id).toBe(pa.id);
    expect((await getProject(b.owner, "gizli")).id).toBe(pb.id);
  });

  it("projesiz eski öğeler değişmeden çalışır (projectId verilmez)", async () => {
    const { member } = await setup();
    const post = await createPost(member, { title: "T", body: "B" });
    expect(post.projectId).toBeNull();
    expect((await listPosts(member)).items).toHaveLength(1);
    expect(await listTodoLists(member)).toHaveLength(0);
  });
});

describe("project consistency fixes", () => {
  it("moving a folder updates its (and its subtree's) project", async () => {
    const u = await createTestUser();
    const { ctx } = await createTestWorkspace(u.id);
    const a = await createProject(ctx, { name: "A projesi" });
    const b = await createProject(ctx, { name: "B projesi" });
    const src = await createFolder(ctx, { name: "src", projectId: a.id });
    const sub = await createFolder(ctx, { name: "alt", parentId: src.id }); // inherits A
    const dest = await createFolder(ctx, { name: "dest", projectId: b.id });
    expect((await db.folder.findUnique({ where: { id: sub.id } }))!.projectId).toBe(a.id);

    await moveFolder(ctx, { id: src.id, targetFolderId: dest.id }); // A -> under a B folder
    expect((await db.folder.findUnique({ where: { id: src.id } }))!.projectId).toBe(b.id);
    expect((await db.folder.findUnique({ where: { id: sub.id } }))!.projectId).toBe(b.id);
  });

  it("an archived project accepts no new subfolder", async () => {
    const u = await createTestUser();
    const { ctx } = await createTestWorkspace(u.id);
    const p = await createProject(ctx, { name: "Arşiv" });
    const root = await createFolder(ctx, { name: "k", projectId: p.id });
    await archiveProject(ctx, p.id);
    expect(await code(createFolder(ctx, { name: "yeni", parentId: root.id }))).toBe("VALIDATION");
  });
});
