-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- AlterTable
ALTER TABLE "TodoList" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- AlterTable
ALTER TABLE "TodoItem" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT;

-- CreateIndex
CREATE INDEX "Post_workspaceId_deletedAt_idx" ON "Post"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "TodoList_workspaceId_deletedAt_idx" ON "TodoList"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "TodoItem_workspaceId_deletedAt_idx" ON "TodoItem"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Folder_workspaceId_deletedAt_idx" ON "Folder"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "File_workspaceId_deletedAt_idx" ON "File"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Document_workspaceId_deletedAt_idx" ON "Document"("workspaceId", "deletedAt");

-- CreateIndex
CREATE INDEX "Event_workspaceId_deletedAt_idx" ON "Event"("workspaceId", "deletedAt");

