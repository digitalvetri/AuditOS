import { execSync } from 'node:child_process'

/**
 * One throwaway Postgres database for the whole test run, pushed from the
 * schema. Tests never touch the dev DB.
 *
 * Requires Postgres to be reachable at TEST_DATABASE_URL — bring it up with
 * `docker compose up -d` from the repo root before running `npm test`.
 */
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  'postgresql://auditos:auditos_dev_pw@localhost:55432/auditos_test?schema=public'

export default async function setup() {
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: TEST_DB_URL },
    stdio: 'pipe',
  })
}
