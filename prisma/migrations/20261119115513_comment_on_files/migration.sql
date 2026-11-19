-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "fileId" TEXT;

-- CreateIndex
CREATE INDEX "Comment_fileId_createdAt_idx" ON "Comment"("fileId", "createdAt");

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A comment still belongs to exactly one subject (a file is now the fifth kind).
ALTER TABLE "Comment" DROP CONSTRAINT "Comment_exactly_one_subject";
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_exactly_one_subject" CHECK (num_nonnulls("postId", "todoItemId", "documentId", "eventId", "fileId") = 1);
