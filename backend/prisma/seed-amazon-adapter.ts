/**
 * One-shot seed: Amazon MTR B2C v1 adapter.
 *
 * REPOTIC-MODULE.md §2.1 — adapters are firm-scoped so each firm can
 * tune transforms without stepping on another firm's seed. This one is
 * fingerprinted against the 78 columns on the real Amazon MTR B2C
 * report (December 2025 sample confirms the column list hasn't shifted
 * since mid-2024). Column mapping / transforms are left minimal in
 * Phase 1 — the goal here is to prove the matched/drifted/no_match
 * flow end to end against a real file.
 */
import { PrismaClient } from '@prisma/client'

const AMAZON_MTR_B2C_V1_HEADERS = [
  'Seller Gstin', 'Invoice Number', 'Invoice Date', 'Transaction Type',
  'Order Id', 'Shipment Id', 'Shipment Date', 'Order Date',
  'Shipment Item Id', 'Quantity', 'Item Description', 'Asin', 'Hsn/sac',
  'Sku', 'Product Tax Code', 'Bill From City', 'Bill From State',
  'Bill From Country', 'Bill From Postal Code', 'Ship From City',
  'Ship From State', 'Ship From Country', 'Ship From Postal Code',
  'Ship To City', 'Ship To State', 'Ship To Country', 'Ship To Postal Code',
  'Invoice Amount', 'Tax Exclusive Gross', 'Total Tax Amount',
  'Cgst Rate', 'Sgst Rate', 'Utgst Rate', 'Igst Rate',
  'Compensatory Cess Rate', 'Principal Amount', 'Principal Amount Basis',
  'Cgst Tax', 'Sgst Tax', 'Igst Tax', 'Utgst Tax', 'Compensatory Cess Tax',
  'Shipping Amount', 'Shipping Amount Basis',
  'Shipping Cgst Tax', 'Shipping Sgst Tax', 'Shipping Utgst Tax',
  'Shipping Igst Tax', 'Shipping Cess Tax Amount',
  'Gift Wrap Amount', 'Gift Wrap Amount Basis',
  'Gift Wrap Cgst Tax', 'Gift Wrap Sgst Tax', 'Gift Wrap Utgst Tax',
  'Gift Wrap Igst Tax', 'Gift Wrap Compensatory Cess Tax',
  'Item Promo Discount', 'Item Promo Discount Basis', 'Item Promo Tax',
  'Shipping Promo Discount', 'Shipping Promo Discount Basis', 'Shipping Promo Tax',
  'Gift Wrap Promo Discount', 'Gift Wrap Promo Discount Basis', 'Gift Wrap Promo Tax',
  'Tcs Cgst Rate', 'Tcs Cgst Amount', 'Tcs Sgst Rate', 'Tcs Sgst Amount',
  'Tcs Utgst Rate', 'Tcs Utgst Amount', 'Tcs Igst Rate', 'Tcs Igst Amount',
  'Warehouse Id', 'Fulfillment Channel', 'Payment Method Code',
  'Credit Note No', 'Credit Note Date',
]

const COLUMN_MAP = {
  invoice_number: 'Invoice Number',
  invoice_date: 'Invoice Date',
  invoice_amount: 'Invoice Amount',
  taxable_value: 'Tax Exclusive Gross',
  total_tax: 'Total Tax Amount',
  hsn: 'Hsn/sac',
  ship_to_state: 'Ship To State',
  seller_gstin: 'Seller Gstin',
  transaction_type: 'Transaction Type',
  credit_note_number: 'Credit Note No',
  credit_note_date: 'Credit Note Date',
}

const COVERAGE = {
  '4A': false,    // B2B — not in B2C report
  '5A': true,     // B2C Large (>= 1 lakh)
  '7': true,      // B2C Small
  '9B': true,     // CDN — via Credit Note No/Date
  '11A': false, '11B': false, '8': false, '6A': false,
  '12': true,     // HSN summary
  '13': true,     // Documents issued
  '14a': true,    // Seller's own supplies through ecommerce
}

async function main() {
  const prisma = new PrismaClient()
  try {
    const org = await prisma.organisation.findFirstOrThrow({ select: { id: true, name: true } })
    const existing = await prisma.rpMarketplaceAdapter.findFirst({
      where: { organisationId: org.id, marketplace: 'amazon', reportKind: 'mtr_b2c', version: 1 },
    })
    if (existing) {
      console.log('Amazon MTR B2C v1 adapter already present:', existing.id)
      return
    }
    const row = await prisma.rpMarketplaceAdapter.create({
      data: {
        organisationId: org.id,
        marketplace: 'amazon',
        reportKind: 'mtr_b2c',
        version: 1,
        detectJson: JSON.stringify(AMAZON_MTR_B2C_V1_HEADERS),
        columnMapJson: JSON.stringify(COLUMN_MAP),
        coverageJson: JSON.stringify(COVERAGE),
        notes: 'Seeded from real December 2025 report (33CPQPS2226M2ZD) — 78 columns.',
        active: true,
      },
    })
    console.log(`Seeded Amazon MTR B2C v1 adapter ${row.id} for firm ${org.name}`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
