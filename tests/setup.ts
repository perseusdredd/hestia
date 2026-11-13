// Runs in every test worker before the test files.
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(".env");
  } catch {
    // ignore - tests that hit the DB will fail with a clear Prisma error.
  }
}
