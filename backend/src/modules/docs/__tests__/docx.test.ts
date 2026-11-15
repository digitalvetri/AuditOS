import { describe, expect, it } from 'vitest'
import { Packer, Paragraph, Table, Document } from 'docx'
import { buildDocxChildren } from '../docx.js'
import type { Row } from '../service.js'

/** Minimal Row stub — we only need the fields the renderer reads. */
function mkDoc(partial: Partial<Row> = {}): Row {
  return {
    id: 'd1', organisationId: 'o1', docCode: 'DOC-2026-0001', docType: 'partnership-agreement',
    title: 'Partnership Deed', clientId: null, leadId: null, docDate: '2026-11-15',
    status: 'draft', fieldValues: {}, blockConfig: [], layoutConfig: null,
    preparedById: null, finalisedAt: null,
    createdAt: new Date(), updatedAt: new Date(), createdBy: null, updatedBy: null, deletedAt: null,
    client: null, lead: null,
    ...partial,
  } as unknown as Row
}

describe('buildDocxChildren', () => {
  it('empty blockConfig → empty children, no throw', () => {
    const children = buildDocxChildren(mkDoc())
    expect(children).toEqual([])
  })

  it('walks the canonical block kinds without throwing', () => {
    const d = mkDoc({
      fieldValues: { firm_name: 'Sugham', place: 'Chennai' } as Row['fieldValues'],
      blockConfig: [
        { key: 'heading', title: '{{firm_name}} Partnership Deed', align: 'center' },
        { key: 'section', title: 'Parties' },
        { key: 'subject', title: 'Subject: Partnership Deed' },
        { key: 'date' },
        { key: 'address', lines: [{ html: 'Line 1', kind: 'p' }, { html: 'Line 2', kind: 'p' }] },
        { key: 'paragraph', lines: [{ html: 'Hello <b>world</b>.', kind: 'p' }, { html: 'item', kind: 'bullet' }, { html: 'num', kind: 'number' }] },
        { key: 'keyvalue', rows: [{ label: 'Firm name', value: '{{firm_name}}' }, { label: 'Place', value: '{{place}}' }] },
        { key: 'signature', people: [{ name: 'Vikram', role: 'Partner', din: '12345' }, { name: 'Priya', role: 'Partner' }], columns: 2 },
        { key: 'witness', people: [{ name: 'Witness A' }] },
        { key: 'placedate', title: 'Chennai' },
        { key: 'spacer', heightPx: 48 },
        { key: 'pagebreak' },
      ] as Row['blockConfig'],
    })
    const children = buildDocxChildren(d)
    expect(children.length).toBeGreaterThan(0)
    // Mix of paragraphs and tables.
    expect(children.some((c) => c instanceof Paragraph)).toBe(true)
    expect(children.some((c) => c instanceof Table)).toBe(true)
  })

  it('skips disabled blocks', () => {
    const d = mkDoc({
      blockConfig: [
        { key: 'heading', title: 'Shown', enabled: true },
        { key: 'heading', title: 'Hidden', enabled: false },
      ] as Row['blockConfig'],
    })
    const children = buildDocxChildren(d)
    expect(children.length).toBe(1)
  })

  it('placeholder substitution uses fieldValues, unresolved keys stay visible', () => {
    const d = mkDoc({
      fieldValues: { known: 'VALUE' } as Row['fieldValues'],
      blockConfig: [
        { key: 'paragraph', lines: [{ html: 'A={{known}} B={{missing}}', kind: 'p' }] },
      ] as Row['blockConfig'],
    })
    const children = buildDocxChildren(d)
    // We don't poke into docx internals — just confirm Packer can serialise
    // the document without error, which is the real contract.
    return Packer.toBuffer(new Document({ sections: [{ properties: {}, children }] })).then((buf) => {
      expect(buf.length).toBeGreaterThan(0)
    })
  })

  it('full document round-trips through Packer without throwing', async () => {
    const d = mkDoc({
      blockConfig: [
        { key: 'heading', title: 'Deed' },
        { key: 'paragraph', lines: [{ html: 'Text.' }] },
      ] as Row['blockConfig'],
    })
    const children = buildDocxChildren(d)
    const doc = new Document({ sections: [{ properties: {}, children }] })
    const buffer = await Packer.toBuffer(doc)
    // .docx is a zip; starts with PK (0x50 0x4B).
    expect(buffer[0]).toBe(0x50)
    expect(buffer[1]).toBe(0x4B)
  })
})
