// Vitest picks this up before any test file is loaded. DATABASE_URL MUST be
// set here because PrismaClient captures the URL at module-import time and
// helpers.ts imports it eagerly.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://auditos:auditos_dev_pw@localhost:55432/auditos_test?schema=public'
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-jwt-secret-not-for-production'
process.env.SIGNED_URL_SECRET = 'test-signed-secret-not-for-production'
