-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "Folder" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "TodoList" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Project_workspaceId_idx" ON "Project"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_slug_key" ON "Project"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "Event_workspaceId_projectId_idx" ON "Event"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "Folder_workspaceId_projectId_idx" ON "Folder"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "Post_workspaceId_projectId_idx" ON "Post"("workspaceId", "projectId");

-- CreateIndex
CREATE INDEX "TodoList_workspaceId_projectId_idx" ON "TodoList"("workspaceId", "projectId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodoList" ADD CONSTRAINT "TodoList_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Folder" ADD CONSTRAINT "Folder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
