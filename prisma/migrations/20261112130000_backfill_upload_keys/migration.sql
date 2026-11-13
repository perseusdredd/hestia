-- Data-only migration (no schema change).
-- Files uploaded before UploadKey existed have no UploadKey row, so their
-- upload tokens could be replayed after the file is deleted (until the token
-- expires). Register every existing File's storage key as used.
INSERT INTO "UploadKey" ("storageKey", "workspaceId", "createdAt")
SELECT "storageKey", "workspaceId", "createdAt" FROM "File"
ON CONFLICT DO NOTHING;
