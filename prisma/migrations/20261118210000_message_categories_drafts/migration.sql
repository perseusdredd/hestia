-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "categoryId" TEXT,
ADD COLUMN     "publishedAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "MessageCategory" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageCategory_workspaceId_idx" ON "MessageCategory"("workspaceId");

-- CreateIndex
CREATE INDEX "Post_workspaceId_categoryId_idx" ON "Post"("workspaceId", "categoryId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MessageCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageCategory" ADD CONSTRAINT "MessageCategory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Existing posts were all published when they were created.
UPDATE "Post" SET "publishedAt" = "createdAt";

-- Default categories for every existing workspace (new workspaces get them in createWorkspace).
INSERT INTO "MessageCategory" ("id", "workspaceId", "name", "emoji", "position", "createdAt", "updatedAt")
SELECT 'c' || substr(md5(w."id" || d."name" || random()::text), 1, 24), w."id", d."name", d."emoji", d."position", NOW(), NOW()
FROM "Workspace" w
CROSS JOIN (VALUES
  ('Duyuru', '📢', 0),
  ('Bilgi', '💡', 1),
  ('Soru', '❓', 2),
  ('Fikir', '🔥', 3),
  ('Günlük Durum', '🗒️', 4)
) AS d("name", "emoji", "position");
