import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'

/**
 * WHO IS BILLED. A client under an organization is billed in the
 * ORGANIZATION's name — invoices and quotations alike — while the document
 * still belongs to the client (Invoice.clientId stays the client, so its
 * receivables and reports are unchanged).
 *
 * Never mix parties: for such a client the name, address and GSTIN come from
 * the organization ONLY. An organization with no GSTIN or no address leaves
 * that field null — it never borrows the client's, because an invoice with
 * the organization's name and the client's GSTIN is a wrong tax invoice.
 *
 * The contact (email, phone, person) is different: it is only where the
 * document is sent. The organization's is used, falling back to the client's
 * only when the organization has none, so a reminder still reaches someone.
 */

type PartyFields = {
  id: string
  clientCode: string
  companyName: string
  address: string | null
  gstin: string | null
  email: string | null
  contactNumber: string | null
  contactPerson: string | null
}

export type ClientWithOrganization = PartyFields & { parentClient?: PartyFields | null }

export interface BillingParty {
  name: string
  address: string | null
  gstin: string | null
  /** True when the organization is billed instead of the client. */
  viaOrganization: boolean
  organization: { id: string; name: string; client_id: string } | null
  /** The client the work is for — set only when billed via an organization. */
  forClient: { name: string; client_id: string; id: string } | null
}

export interface BillingContact {
  name: string
  email: string | null
  contactNumber: string | null
  contactPerson: string | null
}

const PARTY_SELECT = {
  id: true, clientCode: true, companyName: true, address: true, gstin: true,
  email: true, contactNumber: true, contactPerson: true,
} as const

/** Prisma include that loads what billingPartyOf / billingContactOf read. */
export const CLIENT_WITH_ORGANIZATION = {
  select: { ...PARTY_SELECT, parentClient: { select: PARTY_SELECT } },
} as const

const blank = (v: string | null | undefined) => (v && v.trim() ? v : null)

export function billingPartyOf(client: ClientWithOrganization): BillingParty {
  const org = client.parentClient ?? null
  if (!org) {
    return {
      name: client.companyName, address: client.address ?? null, gstin: client.gstin ?? null,
      viaOrganization: false, organization: null, forClient: null,
    }
  }
  return {
    name: org.companyName,
    address: blank(org.address),
    gstin: blank(org.gstin),
    viaOrganization: true,
    organization: { id: org.id, name: org.companyName, client_id: org.clientCode },
    forClient: { id: client.id, name: client.companyName, client_id: client.clientCode },
  }
}

/** Where the document goes: the organization's contact, else the client's. */
export function billingContactOf(client: ClientWithOrganization): BillingContact {
  const org = client.parentClient ?? null
  if (!org) {
    return { name: client.companyName, email: blank(client.email), contactNumber: blank(client.contactNumber), contactPerson: blank(client.contactPerson) }
  }
  const orgEmail = blank(org.email)
  return {
    name: org.companyName,
    email: orgEmail ?? blank(client.email),
    contactNumber: blank(org.contactNumber) ?? blank(client.contactNumber),
    // The greeting follows the address the mail goes to.
    contactPerson: orgEmail ? blank(org.contactPerson) : (blank(client.contactPerson) ?? blank(org.contactPerson)),
  }
}

/** The line that says whose work an organization's invoice is for. */
export function servicesForLine(forClient: { name: string; client_id: string }): string {
  return `Services for: ${forClient.name} (${forClient.client_id})`
}

/** Load one client with its organization. Null when it does not exist. */
export async function loadClientWithOrganization(
  db: Prisma.TransactionClient | typeof prisma, clientId: string,
): Promise<ClientWithOrganization | null> {
  return db.client.findFirst({ where: { id: clientId, deletedAt: null }, ...CLIENT_WITH_ORGANIZATION })
}
