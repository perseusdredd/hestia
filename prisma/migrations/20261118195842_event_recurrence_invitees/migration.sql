-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "recurrence" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "recurrenceUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EventInvitee" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventInvitee_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventInvitee_workspaceId_userId_idx" ON "EventInvitee"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "EventInvitee_eventId_userId_key" ON "EventInvitee"("eventId", "userId");

-- AddForeignKey
ALTER TABLE "EventInvitee" ADD CONSTRAINT "EventInvitee_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventInvitee" ADD CONSTRAINT "EventInvitee_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventInvitee" ADD CONSTRAINT "EventInvitee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
