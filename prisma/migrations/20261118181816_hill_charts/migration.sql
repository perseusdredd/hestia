-- AlterTable
ALTER TABLE "TodoList" ADD COLUMN     "hillNote" TEXT,
ADD COLUMN     "hillPosition" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "HillSnapshot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HillSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HillSnapshot_workspaceId_listId_idx" ON "HillSnapshot"("workspaceId", "listId");

-- AddForeignKey
ALTER TABLE "HillSnapshot" ADD CONSTRAINT "HillSnapshot_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HillSnapshot" ADD CONSTRAINT "HillSnapshot_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TodoList"("id") ON DELETE CASCADE ON UPDATE CASCADE;
