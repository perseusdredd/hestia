-- Claude bot: one login-less user that is a MEMBER of every workspace.
-- Only adds rows; nothing is changed or removed.
INSERT INTO "User" ("id", "name", "email", "updatedAt")
VALUES ('claude-bot', 'Claude', 'claude@bot.hestia.invalid', CURRENT_TIMESTAMP)
ON CONFLICT DO NOTHING;

INSERT INTO "Membership" ("id", "userId", "workspaceId", "role")
SELECT 'cmb' || md5(w."id"), 'claude-bot', w."id", 'MEMBER'
FROM "Workspace" w
ON CONFLICT DO NOTHING;
