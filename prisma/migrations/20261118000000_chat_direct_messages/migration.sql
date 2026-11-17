-- Direct messages: ChatMessage.recipientId (null = public room). Adds only.
ALTER TABLE "ChatMessage" ADD COLUMN "recipientId" TEXT;
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_recipientId_fkey"
  FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "ChatMessage_workspaceId_recipientId_createdAt_idx"
  ON "ChatMessage"("workspaceId", "recipientId", "createdAt");
