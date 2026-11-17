-- Link invitations: no e-mail address, reusable, optional expiry.
-- Additive only: no data is removed or rewritten (existing invites keep their
-- e-mail and expiry; they simply are not reusable).

-- AlterTable
ALTER TABLE "Invitation" ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "expiresAt" DROP NOT NULL,
ADD COLUMN     "reusable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "useCount" INTEGER NOT NULL DEFAULT 0;
