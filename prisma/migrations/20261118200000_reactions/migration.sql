-- CreateTable
CREATE TABLE "Reaction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Reaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Reaction_workspaceId_subjectType_subjectId_idx" ON "Reaction"("workspaceId", "subjectType", "subjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Reaction_userId_subjectType_subjectId_emoji_key" ON "Reaction"("userId", "subjectType", "subjectId", "emoji");

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Reaction" ADD CONSTRAINT "Reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
