-- Photos in chat. Additive only: no data is removed or rewritten.

-- AlterTable
ALTER TABLE "File" ADD COLUMN     "fromChat" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "fileId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ChatMessage_fileId_key" ON "ChatMessage"("fileId");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File"("id") ON DELETE SET NULL ON UPDATE CASCADE;
