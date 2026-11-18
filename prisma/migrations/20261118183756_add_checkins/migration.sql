-- CreateTable
CREATE TABLE "CheckinQuestion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "weekdays" INTEGER[],
    "hour" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckinQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckinRound" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "dateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckinRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CheckinAnswer" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckinAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckinQuestion_workspaceId_idx" ON "CheckinQuestion"("workspaceId");

-- CreateIndex
CREATE INDEX "CheckinRound_workspaceId_createdAt_idx" ON "CheckinRound"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CheckinRound_questionId_dateKey_key" ON "CheckinRound"("questionId", "dateKey");

-- CreateIndex
CREATE INDEX "CheckinAnswer_workspaceId_idx" ON "CheckinAnswer"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CheckinAnswer_roundId_userId_key" ON "CheckinAnswer"("roundId", "userId");

-- AddForeignKey
ALTER TABLE "CheckinQuestion" ADD CONSTRAINT "CheckinQuestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinQuestion" ADD CONSTRAINT "CheckinQuestion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinRound" ADD CONSTRAINT "CheckinRound_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinRound" ADD CONSTRAINT "CheckinRound_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "CheckinQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinAnswer" ADD CONSTRAINT "CheckinAnswer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinAnswer" ADD CONSTRAINT "CheckinAnswer_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "CheckinRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CheckinAnswer" ADD CONSTRAINT "CheckinAnswer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
