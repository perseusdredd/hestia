import { afterAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { createFolder } from "@/server/files";
import { createPost, listPosts } from "@/server/messages";
import {
  createProjectFromTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  renameTemplate,
  saveProjectAsTemplate,
} from "@/server/project-templates";
import {
  assertAssignableProject,
  createProject,
  getProject,
  getProjectOverview,
  listProjectOptions,
  listProjects,
  renameProject,
} from "@/server/projects";
import { searchWorkspace } from "@/server/search";
import { createTodoItem, createTodoList, createTodoSection, listTodoLists, setTodoItemDone } from "@/server/todos";

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
  const { user: memberUser, ctx: member } = await createMember(workspace.id, "MEMBER");
  const { ctx: guest } = await createMember(workspace.id, "GUEST");
  return { workspace, owner: ctx, admin, member, memberUser, guest };
}

/** A realistic source project: 2 lists, a section, assigned/dated/done items, folders with a file, messages. */
async function seedProject(
  ctx: Awaited<ReturnType<typeof setup>>["owner"],
  assigneeId: string,
  name = "Web Sitesi",
) {
  const project = await createProject(ctx, { name, description: "Yeni site" });
  const list = await createTodoList(ctx, { name: "Tasarım", projectId: project.id });
  const section = await createTodoSection(ctx, list.id, { name: "Aşama 1" });
  const a = await createTodoItem(ctx, list.id, {
    title: "Logo",
    notes: "Vektör olsun",
    assigneeId,
    dueDate: "2030-05-01",
    sectionId: section.id,
  });
  await createTodoItem(ctx, list.id, { title: "Renkler", dueDate: "2030-05-02", extraAssigneeIds: [assigneeId] });
  await setTodoItemDone(ctx, a.id, true);
  const list2 = await createTodoList(ctx, { name: "Yayın", projectId: project.id });
  await createTodoItem(ctx, list2.id, { title: "Alan adı", assigneeId });
  const root = await createFolder(ctx, { name: "Belgeler", projectId: project.id });
  const sub = await createFolder(ctx, { name: "Sözleşmeler", parentId: root.id });
  await db.file.create({
    data: {
      workspaceId: ctx.workspaceId,
      uploadedById: ctx.userId,
      folderId: sub.id,
      name: "sozlesme.pdf",
      mimeType: "application/pdf",
      size: 10,
      storageKey: `${ctx.workspaceId}/tpl-${Date.now()}-${Math.random()}.pdf`,
    },
  });
  await createPost(ctx, { title: "Hoş geldiniz", body: "Gizli içerik gövdesi", projectId: project.id });
  await createPost(ctx, { title: "Taslak not", body: "x", projectId: project.id, draft: true });
  return { project, list, list2, root, sub };
}

describe("şablon oluşturma ve roller", () => {
  it("OWNER ve ADMIN boş şablon oluşturur; MEMBER ve GUEST oluşturamaz", async () => {
    const { owner, admin, member, guest } = await setup();
    const t = await createTemplate(owner, { name: "  Başlangıç  ", description: "Not" });
    expect(t.name).toBe("Başlangıç");
    expect(t.description).toBe("Not");
    expect(t.counts).toEqual({ todoLists: 0, todoItems: 0, folders: 0, posts: 0 });
    expect((await createTemplate(admin, { name: "Ek" })).name).toBe("Ek");
    expect(await code(createTemplate(member, { name: "x" }))).toBe("FORBIDDEN");
    expect(await code(createTemplate(guest, { name: "x" }))).toBe("FORBIDDEN");
    expect(await code(createTemplate(owner, { name: "   " }))).toBe("VALIDATION");
    expect(await code(createTemplate(owner, { name: "a".repeat(81) }))).toBe("VALIDATION");
  });

  it("aynı adlı şablonlar benzersiz slug alır", async () => {
    const { owner } = await setup();
    const a = await createTemplate(owner, { name: "Aynı" });
    const b = await createTemplate(owner, { name: "Aynı" });
    expect(a.slug).toBe("ayni");
    expect(b.slug).toBe("ayni-2");
    const p = await createProject(owner, { name: "Aynı" });
    expect(p.slug).toBe("ayni-3");
  });

  it("şablon sayısı en fazla 50", async () => {
    const { owner } = await setup();
    for (let i = 0; i < 50; i++) await createTemplate(owner, { name: `S${i}` });
    expect(await code(createTemplate(owner, { name: "fazla" }))).toBe("VALIDATION");
  });

  it("yeniden adlandırma ve silme yalnızca ADMIN+; slug değişmez", async () => {
    const { owner, admin, member, guest } = await setup();
    const t = await createTemplate(owner, { name: "Eski" });
    expect(await code(renameTemplate(member, t.id, { name: "Yeni" }))).toBe("FORBIDDEN");
    expect(await code(renameTemplate(guest, t.id, { name: "Yeni" }))).toBe("FORBIDDEN");
    const r = await renameTemplate(admin, t.id, { name: "Yeni", description: "Açıklama" });
    expect(r.name).toBe("Yeni");
    expect(r.description).toBe("Açıklama");
    expect(r.slug).toBe(t.slug);
    expect((await renameTemplate(admin, t.id, { description: "" })).description).toBeNull();
    expect(await code(renameTemplate(admin, t.id, { name: " " }))).toBe("VALIDATION");
    expect(await code(deleteTemplate(member, t.id))).toBe("FORBIDDEN");
    await deleteTemplate(admin, t.id);
    expect(await listTemplates(owner)).toHaveLength(0);
    expect(await code(getTemplate(owner, t.id))).toBe("NOT_FOUND");
    expect(await code(deleteTemplate(owner, t.id))).toBe("NOT_FOUND");
  });
});

describe("şablon olarak kaydet", () => {
  it("yapıyı kopyalar; kişi, tarih, durum, dosya içeriği ve mesaj gövdesi kopyalanmaz", async () => {
    const { owner, memberUser } = await setup();
    const { project } = await seedProject(owner, memberUser.id);
    const t = await saveProjectAsTemplate(owner, project.id);
    expect(t.name).toBe("Web Sitesi");
    expect(t.description).toBe("Yeni site");
    expect(t.counts).toEqual({ todoLists: 2, todoItems: 3, folders: 2, posts: 1 }); // taslak mesaj alınmaz

    const row = await db.project.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.isTemplate).toBe(true);
    const json = JSON.stringify(row.templateSpec);
    expect(json).not.toContain(memberUser.id);
    expect(json).not.toContain("2030");
    expect(json).not.toContain("sozlesme");
    expect(json).not.toContain("Gizli içerik");
    expect(json).not.toContain("Taslak not");
    // Şablon gerçek içerik satırı oluşturmaz.
    expect(await db.todoList.count({ where: { projectId: t.id } })).toBe(0);
    expect(await db.folder.count({ where: { projectId: t.id } })).toBe(0);
    expect(await db.post.count({ where: { projectId: t.id } })).toBe(0);
    // Kaynak proje değişmedi.
    expect(await db.todoItem.count({ where: { list: { projectId: project.id }, assigneeId: memberUser.id } })).toBe(2);
  });

  it("ad/açıklama verilebilir; sadece ADMIN+; kaynak proje çalışma alanında olmalı", async () => {
    const { owner, admin, member, memberUser } = await setup();
    const { project } = await seedProject(owner, memberUser.id);
    const t = await saveProjectAsTemplate(admin, project.id, { name: "Özel Ad", description: "" });
    expect(t.name).toBe("Özel Ad");
    expect(t.description).toBeNull();
    expect(await code(saveProjectAsTemplate(member, project.id))).toBe("FORBIDDEN");
    expect(await code(saveProjectAsTemplate(owner, "yok-boyle-bir-proje"))).toBe("NOT_FOUND");
    // Bir şablon başka bir şablona kaynak olamaz.
    expect(await code(saveProjectAsTemplate(owner, t.id))).toBe("NOT_FOUND");
    expect(await code(createTemplate(owner, { name: "x", fromProjectId: t.id }))).toBe("NOT_FOUND");
  });

  it("silinmiş (çöp) liste, madde, klasör ve mesajlar kopyalanmaz", async () => {
    const { owner, memberUser } = await setup();
    const { project, list, list2, root } = await seedProject(owner, memberUser.id);
    await db.todoList.update({ where: { id: list2.id }, data: { deletedAt: new Date() } });
    await db.todoItem.updateMany({ where: { listId: list.id, title: "Renkler" }, data: { deletedAt: new Date() } });
    await db.folder.updateMany({ where: { parentId: root.id }, data: { deletedAt: new Date() } });
    await db.post.updateMany({ where: { projectId: project.id }, data: { deletedAt: new Date() } });
    const t = await saveProjectAsTemplate(owner, project.id);
    expect(t.counts).toEqual({ todoLists: 1, todoItems: 1, folders: 1, posts: 0 });
  });

  it("çalışma alanı yalıtımı: başka alanın projesi kaynak olamaz", async () => {
    const a = await setup();
    const b = await setup();
    const { project } = await seedProject(a.owner, a.memberUser.id);
    expect(await code(saveProjectAsTemplate(b.owner, project.id))).toBe("NOT_FOUND");
    expect(await code(createTemplate(b.owner, { name: "x", fromProjectId: project.id }))).toBe("NOT_FOUND");
  });
});

describe("şablondan proje oluşturma", () => {
  it("bağımsız, yeni kimlikli bir proje üretir; atama/tarih yok, hepsi OPEN, pozisyonlar yoğun", async () => {
    const { owner, admin, memberUser, workspace } = await setup();
    const src = await seedProject(owner, memberUser.id);
    const t = await saveProjectAsTemplate(owner, src.project.id);

    const created = await createProjectFromTemplate(admin, t.id, { name: "Müşteri A" });
    expect(created.name).toBe("Müşteri A");
    expect(created.description).toBe("Yeni site");
    expect(created.archived).toBe(false);
    expect(created.id).not.toBe(t.id);
    expect(created.id).not.toBe(src.project.id);
    const row = await db.project.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.isTemplate).toBe(false);
    expect(row.templateSpec).toBeNull();
    expect(row.workspaceId).toBe(workspace.id);

    const lists = await db.todoList.findMany({
      where: { projectId: created.id },
      orderBy: { position: "asc" },
      include: { items: { orderBy: { position: "asc" } }, sections: true },
    });
    expect(lists.map((l) => l.name)).toEqual(["Tasarım", "Yayın"]);
    expect(lists.every((l) => l.workspaceId === workspace.id && l.deletedAt === null)).toBe(true);
    expect(lists[1].position).toBe(lists[0].position + 1);
    expect(lists.map((l) => l.id)).not.toContain(src.list.id);
    const [design, publish] = lists;
    expect(design.items.map((i) => i.title)).toEqual(["Logo", "Renkler"]);
    expect(design.items.map((i) => i.position)).toEqual([0, 1]);
    expect(publish.items.map((i) => i.position)).toEqual([0]);
    for (const it of [...design.items, ...publish.items]) {
      expect(it.status).toBe("OPEN");
      expect(it.assigneeId).toBeNull();
      expect(it.dueDate).toBeNull();
      expect(it.startOn).toBeNull();
      expect(it.completedAt).toBeNull();
      expect(it.remindAt).toBeNull();
      expect(it.createdById).toBe(admin.userId);
    }
    expect(design.items[0].notes).toBe("Vektör olsun");
    expect(await db.todoAssignee.count({ where: { todoItem: { list: { projectId: created.id } } } })).toBe(0);
    // Bölüm yeni kimlikle yeniden bağlandı.
    expect(design.sections).toHaveLength(1);
    expect(design.sections[0].name).toBe("Aşama 1");
    expect(design.sections[0].listId).toBe(design.id);
    expect(design.items[0].sectionId).toBe(design.sections[0].id);
    expect(design.items[1].sectionId).toBeNull();
    expect(design.sections[0].id).not.toBe(
      (await db.todoSection.findFirstOrThrow({ where: { listId: src.list.id } })).id,
    );

    // Klasörler: yapı var, dosya yok.
    const folders = await db.folder.findMany({ where: { projectId: created.id }, orderBy: { name: "asc" } });
    expect(folders.map((f) => f.name)).toEqual(["Belgeler (2)", "Sözleşmeler"]);
    const newRoot = folders.find((f) => f.parentId === null)!;
    expect(newRoot.id).not.toBe(src.root.id);
    const newSub = folders.find((f) => f.parentId !== null)!;
    expect(newSub.parentId).toBe(newRoot.id);
    expect(newSub.name).toBe("Sözleşmeler");
    expect(await db.file.count({ where: { folderId: { in: folders.map((f) => f.id) } } })).toBe(0);

    // Mesajlar: taslak olarak, yayınlanmaz, yazar çağıran.
    const posts = await db.post.findMany({ where: { projectId: created.id } });
    expect(posts).toHaveLength(1);
    expect(posts[0].title).toBe("Hoş geldiniz");
    expect(posts[0].publishedAt).toBeNull();
    expect(posts[0].scheduledFor).toBeNull();
    expect(posts[0].authorId).toBe(admin.userId);
    expect(posts[0].body).not.toContain("Gizli içerik");
    expect(posts[0].body.length).toBeGreaterThan(0);

    // Proje sayfası verisi çalışır.
    const ov = await getProjectOverview(admin, created.slug);
    expect(ov.counts).toMatchObject({ todoLists: 2, folders: 1, posts: 1 });
    expect(ov.posts[0].isDraft).toBe(true);
  });

  it("kopyayı düzenlemek şablonu ve diğer projeleri etkilemez", async () => {
    const { owner, memberUser } = await setup();
    const src = await seedProject(owner, memberUser.id);
    const t = await saveProjectAsTemplate(owner, src.project.id);
    const one = await createProjectFromTemplate(owner, t.id, { name: "Bir" });
    const two = await createProjectFromTemplate(owner, t.id, { name: "İki" });
    const specBefore = JSON.stringify((await db.project.findUniqueOrThrow({ where: { id: t.id } })).templateSpec);

    const list = await db.todoList.findFirstOrThrow({ where: { projectId: one.id, name: "Tasarım" } });
    await createTodoItem(owner, list.id, { title: "Yeni madde", assigneeId: memberUser.id, dueDate: "2031-01-01" });
    await db.todoList.update({ where: { id: list.id }, data: { name: "Değişti" } });
    await createFolder(owner, { name: "Ekstra", projectId: one.id });
    await renameProject(owner, one.id, { name: "Bir (yeni)" });
    await db.project.update({ where: { id: one.id }, data: { archived: true } });

    expect((await db.project.findUniqueOrThrow({ where: { id: t.id } })).templateSpec).toEqual(JSON.parse(specBefore));
    expect((await getTemplate(owner, t.id)).counts).toEqual({ todoLists: 2, todoItems: 3, folders: 2, posts: 1 });
    expect(await db.todoList.count({ where: { projectId: two.id, name: "Tasarım" } })).toBe(1);
    expect(await db.todoItem.count({ where: { list: { projectId: two.id } } })).toBe(3);
    expect(await db.folder.count({ where: { projectId: two.id } })).toBe(2);
    expect((await getProject(owner, two.slug)).archived).toBe(false);
    // Şablonu silmek oluşturulan projeleri etkilemez.
    await deleteTemplate(owner, t.id);
    expect(await db.todoList.count({ where: { projectId: two.id } })).toBe(2);
    expect((await getProject(owner, two.slug)).name).toBe("İki");
  });

  it("kaynak projeyi değiştirmek önceden kaydedilmiş şablonu değiştirmez", async () => {
    const { owner, memberUser } = await setup();
    const src = await seedProject(owner, memberUser.id);
    const t = await saveProjectAsTemplate(owner, src.project.id);
    await createTodoItem(owner, src.list.id, { title: "Sonradan eklendi" });
    await db.todoList.update({ where: { id: src.list2.id }, data: { deletedAt: new Date() } });
    const created = await createProjectFromTemplate(owner, t.id, { name: "Kopya" });
    expect(await db.todoList.count({ where: { projectId: created.id } })).toBe(2);
    expect(await db.todoItem.count({ where: { list: { projectId: created.id }, title: "Sonradan eklendi" } })).toBe(0);
  });

  it("boş şablon boş proje üretir; ad zorunlu; açıklama geçersiz kılınabilir", async () => {
    const { owner } = await setup();
    const t = await createTemplate(owner, { name: "Boş", description: "Şablon açıklaması" });
    expect(await code(createProjectFromTemplate(owner, t.id, { name: " " }))).toBe("VALIDATION");
    const p = await createProjectFromTemplate(owner, t.id, { name: "Boş Proje", description: "Kendi" });
    expect(p.description).toBe("Kendi");
    const ov = await getProjectOverview(owner, p.slug);
    expect(ov.counts).toEqual({ posts: 0, todoLists: 0, folders: 0, events: 0 });
  });

  it("kök klasör adı çakışırsa numaralanır (çalışma alanında kök klasör adları benzersiz)", async () => {
    const { owner, memberUser } = await setup();
    const src = await seedProject(owner, memberUser.id);
    const t = await saveProjectAsTemplate(owner, src.project.id);
    const one = await createProjectFromTemplate(owner, t.id, { name: "Bir" });
    const two = await createProjectFromTemplate(owner, t.id, { name: "İki" });
    const names = async (id: string) =>
      (await db.folder.findMany({ where: { projectId: id, parentId: null } })).map((f) => f.name);
    expect(await names(one.id)).toEqual(["Belgeler (2)"]);
    expect(await names(two.id)).toEqual(["Belgeler (3)"]);
  });

  it("proje sınırı şablondan oluşturmada da geçerlidir; şablonlar sayılmaz", async () => {
    const { owner } = await setup();
    const t = await createTemplate(owner, { name: "S" });
    await db.project.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({
        workspaceId: owner.workspaceId,
        createdById: owner.userId,
        name: `P${i}`,
        slug: `p-${i}`,
        position: i,
      })),
    });
    expect(await code(createProjectFromTemplate(owner, t.id, { name: "fazla" }))).toBe("VALIDATION");
    expect(await db.project.count({ where: { workspaceId: owner.workspaceId } })).toBe(201); // başarısız kopya iz bırakmadı
  });

  it("yalnızca ADMIN+; MEMBER/GUEST kullanamaz", async () => {
    const { owner, admin, member, guest } = await setup();
    const t = await createTemplate(owner, { name: "S" });
    expect(await code(createProjectFromTemplate(member, t.id, { name: "x" }))).toBe("FORBIDDEN");
    expect(await code(createProjectFromTemplate(guest, t.id, { name: "x" }))).toBe("FORBIDDEN");
    expect(await code(createProjectFromTemplate(admin, t.id, { name: "x" }))).toBe("OK");
    expect(await code(createProjectFromTemplate(owner, "yok", { name: "x" }))).toBe("NOT_FOUND");
  });

  it("gerçek bir projenin kimliği şablon kimliği olarak kullanılamaz", async () => {
    const { owner } = await setup();
    const p = await createProject(owner, { name: "Gerçek" });
    expect(await code(createProjectFromTemplate(owner, p.id, { name: "x" }))).toBe("NOT_FOUND");
    expect(await code(renameTemplate(owner, p.id, { name: "x" }))).toBe("NOT_FOUND");
    expect(await code(deleteTemplate(owner, p.id))).toBe("NOT_FOUND");
    expect((await getProject(owner, p.slug)).id).toBe(p.id);
  });

  it("çalışma alanı yalıtımı: başka alanın şablonu görünmez, kullanılamaz, silinemez", async () => {
    const a = await setup();
    const b = await setup();
    const t = await createTemplate(a.owner, { name: "Gizli" });
    expect(await listTemplates(b.owner)).toHaveLength(0);
    expect(await code(createProjectFromTemplate(b.owner, t.id, { name: "x" }))).toBe("NOT_FOUND");
    expect(await code(renameTemplate(b.owner, t.id, { name: "x" }))).toBe("NOT_FOUND");
    expect(await code(deleteTemplate(b.owner, t.id))).toBe("NOT_FOUND");
    expect(await code(getTemplate(b.owner, t.id))).toBe("NOT_FOUND");
    expect((await listTemplates(a.owner)).map((x) => x.id)).toEqual([t.id]);
    expect(await db.project.count({ where: { workspaceId: b.owner.workspaceId } })).toBe(0);
  });

  it("team-only (internal) öğeler kopyada team-only kalır", async () => {
    const { owner } = await setup();
    const p = await createProject(owner, { name: "Dahili" });
    await createTodoList(owner, { name: "Gizli liste", projectId: p.id, internal: true });
    await createFolder(owner, { name: "Gizli klasör", projectId: p.id, internal: true });
    await createPost(owner, { title: "Gizli mesaj", body: "x", projectId: p.id, internal: true });
    const t = await saveProjectAsTemplate(owner, p.id);
    const c = await createProjectFromTemplate(owner, t.id, { name: "Dahili kopya" });
    expect(await db.todoList.count({ where: { projectId: c.id, internal: true } })).toBe(1);
    expect(await db.folder.count({ where: { projectId: c.id, internal: true } })).toBe(1);
    expect(await db.post.count({ where: { projectId: c.id, internal: true } })).toBe(1);
  });
});

describe("şablonlar normal akışlardan dışlanır", () => {
  it("listProjects, listProjectOptions, getProject ve atama kontrolünde görünmez", async () => {
    const { owner, admin, member } = await setup();
    const real = await createProject(owner, { name: "Gerçek" });
    const t = await createTemplate(owner, { name: "Şablon X" });
    const l = await listProjects(owner);
    expect(l.active.map((p) => p.id)).toEqual([real.id]);
    expect(l.archived).toHaveLength(0);
    expect((await listProjectOptions(member)).map((p) => p.id)).toEqual([real.id]);
    expect(await code(getProject(owner, t.slug))).toBe("NOT_FOUND");
    expect(await code(getProjectOverview(owner, t.slug))).toBe("NOT_FOUND");
    expect(await code(assertAssignableProject(owner, t.id))).toBe("VALIDATION");
    expect(await code(createTodoList(owner, { name: "L", projectId: t.id }))).toBe("VALIDATION");
    expect(await code(createFolder(owner, { name: "F", projectId: t.id }))).toBe("VALIDATION");
    expect(await code(createPost(owner, { title: "P", body: "b", projectId: t.id }))).toBe("VALIDATION");
    // Proje yönetim uçları şablonu proje olarak görmez.
    expect(await code(renameProject(admin, t.id, { name: "x" }))).toBe("NOT_FOUND");
  });

  it("şablonlar proje sayısına ve konumlara dahil değil; ilk gerçek proje konum 0 alır", async () => {
    const { owner } = await setup();
    await createTemplate(owner, { name: "T1" });
    await createTemplate(owner, { name: "T2" });
    const p = await createProject(owner, { name: "İlk" });
    expect(p.position).toBe(0);
    const q = await createProject(owner, { name: "İkinci" });
    expect(q.position).toBe(1);
  });

  it("şablon içeriği çalışma alanı genelindeki listelerde ve aramada görünmez", async () => {
    const { owner, admin } = await setup();
    const p = await createProject(owner, { name: "Kaynak" });
    await createTodoList(owner, { name: "Benzersizliste", projectId: p.id });
    await createFolder(owner, { name: "Benzersizklasor", projectId: p.id });
    await createPost(owner, { title: "Benzersizbaslik", body: "b", projectId: p.id });
    const before = {
      lists: (await listTodoLists(admin)).length,
      posts: (await listPosts(admin)).items.length,
    };
    const t = await saveProjectAsTemplate(owner, p.id);
    expect(t.counts.todoLists).toBe(1);
    expect((await listTodoLists(admin)).length).toBe(before.lists);
    expect((await listPosts(admin)).items.length).toBe(before.posts);
    expect(await db.todoList.count({ where: { name: "Benzersizliste", workspaceId: owner.workspaceId } })).toBe(1);
    const hits = await searchWorkspace(admin, { q: "Benzersizliste" });
    expect(JSON.stringify(hits)).not.toContain(t.id);
  });
});

describe("misafir ve üye görünürlüğü", () => {
  it("listTemplates MEMBER ve GUEST için boş döner, getTemplate reddeder", async () => {
    const { owner, member, guest } = await setup();
    const t = await createTemplate(owner, { name: "Sadece yönetici" });
    expect(await listTemplates(owner)).toHaveLength(1);
    expect(await listTemplates(member)).toEqual([]);
    expect(await listTemplates(guest)).toEqual([]);
    expect(await code(getTemplate(member, t.id))).toBe("FORBIDDEN");
    expect(await code(getTemplate(guest, t.id))).toBe("FORBIDDEN");
  });

  it("misafir şablondan oluşan projenin team-only öğelerini görmez", async () => {
    const { owner, guest } = await setup();
    const p = await createProject(owner, { name: "Dahili" });
    await createTodoList(owner, { name: "Ekip listesi", projectId: p.id, internal: true });
    await createTodoList(owner, { name: "Herkese açık", projectId: p.id });
    const t = await saveProjectAsTemplate(owner, p.id);
    const c = await createProjectFromTemplate(owner, t.id, { name: "Kopya" });
    const ov = await getProjectOverview(guest, c.slug);
    expect(ov.todoLists.map((l) => l.name)).toEqual(["Herkese açık"]);
  });
});
