-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "remindAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TodoItem" ADD COLUMN     "remindAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Event_remindAt_reminderSentAt_idx" ON "Event"("remindAt", "reminderSentAt");

-- CreateIndex
CREATE INDEX "TodoItem_remindAt_reminderSentAt_idx" ON "TodoItem"("remindAt", "reminderSentAt");
