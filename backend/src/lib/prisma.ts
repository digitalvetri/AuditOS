import { PrismaClient } from '@prisma/client'

export const prisma = new PrismaClient()

/** Soft-delete convention: every read of a mutable table filters this in. */
export const alive = { deletedAt: null }
