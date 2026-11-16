import type { Prisma } from '@prisma/client'

/**
 * Which client documents the client's own portal link shows.
 *
 * `ClientDocument.visibleToClient` is set when staff share (true) or hide
 * (false) a document on purpose. Left null, the default rule applies:
 * the client sees what was asked of them — a request (`requestedAt`), a file
 * received against an organization's request (`sourceRequestId`) — and what
 * they sent through the portal. Everything staff upload themselves (working
 * papers, internal notes, draft computations) stays internal until shared.
 *
 * The default rule is also what existing documents get, so no data migration
 * is needed: the old "show everything" is narrowed to exactly the requested
 * and client-sent documents.
 */
export const PORTAL_UPLOADER = 'portal'

export const CLIENT_VISIBLE_DOC: Prisma.ClientDocumentWhereInput = {
  OR: [
    { visibleToClient: true },
    {
      visibleToClient: null,
      OR: [
        { requestedAt: { not: null } },
        { sourceRequestId: { not: null } },
        { versions: { some: { uploadedBy: PORTAL_UPLOADER } } },
      ],
    },
  ],
}

/** The same rule for a loaded row. `versions` must be all of its versions (or at least every portal one). */
export function isVisibleToClient(d: {
  visibleToClient: boolean | null
  requestedAt: Date | null
  sourceRequestId: string | null
  versions?: { uploadedBy: string }[]
}): boolean {
  if (d.visibleToClient !== null) return d.visibleToClient
  return d.requestedAt !== null || d.sourceRequestId !== null || (d.versions ?? []).some((v) => v.uploadedBy === PORTAL_UPLOADER)
}
