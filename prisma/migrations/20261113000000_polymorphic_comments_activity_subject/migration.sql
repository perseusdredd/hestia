-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "subjectId" TEXT,
ADD COLUMN     "subjectType" TEXT;

-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "documentId" TEXT,
ADD COLUMN     "eventId" TEXT,
ADD COLUMN     "todoItemId" TEXT,
ALTER COLUMN "postId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Activity_workspaceId_subjectType_subjectId_idx" ON "Activity"("workspaceId", "subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "Comment_todoItemId_createdAt_idx" ON "Comment"("todoItemId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_documentId_createdAt_idx" ON "Comment"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "Comment_eventId_createdAt_idx" ON "Comment"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_todoItemId_fkey" FOREIGN KEY ("todoItemId") REFERENCES "TodoItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A comment belongs to exactly one subject.
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_exactly_one_subject" CHECK (num_nonnulls("postId", "todoItemId", "documentId", "eventId") = 1);
