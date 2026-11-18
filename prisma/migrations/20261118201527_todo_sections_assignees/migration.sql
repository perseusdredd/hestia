-- AlterTable
ALTER TABLE "TodoItem" ADD COLUMN     "sectionId" TEXT,
ADD COLUMN     "startOn" DATE;

-- CreateTable
CREATE TABLE "TodoSection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TodoSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TodoAssignee" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "todoItemId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TodoAssignee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TodoSection_workspaceId_listId_idx" ON "TodoSection"("workspaceId", "listId");

-- CreateIndex
CREATE INDEX "TodoAssignee_workspaceId_userId_idx" ON "TodoAssignee"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "TodoAssignee_todoItemId_userId_key" ON "TodoAssignee"("todoItemId", "userId");

-- CreateIndex
CREATE INDEX "TodoItem_sectionId_idx" ON "TodoItem"("sectionId");

-- AddForeignKey
ALTER TABLE "TodoItem" ADD CONSTRAINT "TodoItem_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "TodoSection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodoSection" ADD CONSTRAINT "TodoSection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodoSection" ADD CONSTRAINT "TodoSection_listId_fkey" FOREIGN KEY ("listId") REFERENCES "TodoList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodoAssignee" ADD CONSTRAINT "TodoAssignee_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodoAssignee" ADD CONSTRAINT "TodoAssignee_todoItemId_fkey" FOREIGN KEY ("todoItemId") REFERENCES "TodoItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TodoAssignee" ADD CONSTRAINT "TodoAssignee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
