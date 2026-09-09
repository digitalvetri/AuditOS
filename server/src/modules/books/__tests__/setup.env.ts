// Vitest picks this up before any test file is loaded. We MUST set
// DATABASE_URL here (not in setup.global.ts alone) because PrismaClient
// captures the URL at module-import time and helpers.ts imports it eagerly.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://auditos:auditos_dev_pw@localhost:55432/auditos_test?schema=public'
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'books-test-jwt-secret-not-for-production'
process.env.SIGNED_URL_SECRET = 'books-test-signed-secret-not-for-production'
