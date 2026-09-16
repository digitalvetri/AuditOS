/**
 * Apply the Task invariants from the command line:
 *   npx tsx src/modules/task/db/apply.ts
 * The API also applies them at start-up; this is for migrations and CI.
 */
import '../../../lib/env.js'
import { PrismaClient } from '@prisma/client'
import { applyTaskInvariants } from './invariants.js'

const prisma = new PrismaClient()
applyTaskInvariants(prisma)
  .then((n) => console.log(`Task invariants applied (${n} statements)`))
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
