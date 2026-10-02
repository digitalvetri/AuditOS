/**
 * Two company documents taken from their own reference files: a private
 * limited company's authorised-signatory confirmation, and an eleven-month
 * lease deed. Both are composed from the shared block vocabulary — only
 * their content and fields are their own.
 */
import type { RawBlock } from '../model';

const p = (html: string, align: 'justify' | 'left' | 'center' | 'right' = 'justify') => ({ align, html });
const li = (html: string) => ({ kind: 'number' as const, align: 'justify' as const, html });

/** Authorised Signatory — Private Limited: a letterhead confirmation. */
export const AUTHORISED_SIGNATORY_PVT_LTD: RawBlock[] = [
  { key: 'heading', title: '{{company_name}}', variant: 'title', align: 'center' },
  { key: 'address', lines: [p('{{registered_office}}', 'center')] },
  { key: 'heading', title: 'To Whom It May Concern', variant: 'subtitle', align: 'center' },
  { key: 'date', title: 'Date:', align: 'right' },
  { key: 'heading', title: 'Authorised Signatory Confirmation', variant: 'subtitle', align: 'center' },
  { key: 'paragraph', lines: [
    p('It is hereby confirmed that <b>{{signatory_name}}</b>, {{signatory_designation}} of {{company_name}}, be authorised to act as an authorised signatory on behalf of the company for all official, financial, and legal matters, including but not limited to signing documents, agreements, forms, and correspondence.'),
  ] },
  { key: 'paragraph', lines: [
    p('He/She shall also be the authorized representative for signing of GST related compliances and bank account compliances. This authorisation is effective as of the date of this letter and shall remain valid until further written notice is issued by the company.'),
  ] },
  { key: 'paragraph', lines: [p('Thank you.', 'left')] },
  // Two signatures side by side, each under the company's own line.
  { key: 'signature', title: 'Yours faithfully,', columns: 2, people: [
    { name: '{{signatory1_name}}', role: '', din: '', note: 'For {{company_name}}' },
    { name: '{{signatory2_name}}', role: '', din: '', note: 'For {{company_name}}' },
  ] },
];

/** Lease Deed — an eleven-month commercial lease with its schedule. */
export const LEASE_DEED: RawBlock[] = [
  { key: 'heading', title: 'LEASE DEED', variant: 'title', align: 'center' },
  { key: 'paragraph', lines: [
    p('This INDENTURE OF LEASE is entered into at {{place}} on this the {{execution_day}} ({{execution_date}})'),
  ] },
  { key: 'heading', title: 'BETWEEN', variant: 'subtitle', align: 'center' },
  { key: 'paragraph', lines: [
    p('1. {{lessor_name}}, (holding Aadhaar No – {{lessor_aadhaar}}), residing at {{lessor_address}}, hereinafter called the <b>LESSOR</b>'),
    p('2. {{lessee_name}}, having Registered office at {{lessee_address}}, represented by {{lessee_represented_by}} (hereinafter referred to as the “LESSEE”, which term shall, unless it be repugnant to the context or meaning thereof, mean and include its successors and permitted assignees)'),
  ] },
  { key: 'heading', title: 'AND THE SAME WITNESSETH', variant: 'subtitle', align: 'center' },
  { key: 'paragraph', lines: [
    p('WHEREAS the LESSOR herein is the absolute owner of the property more fully described in the schedule hereunder written (hereinafter referred to as the ‘demised premises’) and whereas the Lessor has got to lease out the same.'),
    p('Whereas the lessee has intended to do business in the name and style {{lessee_name}}.'),
    p('AND WHEREAS the said Lessee required the demised Premises for the purpose of running their business and offered to take same on rental basis for a period of {{lease_period}} from {{lease_from}} to {{lease_to}} on the terms hereinafter provided and the Lessor accepted the said offer on the terms and conditions herein below.'),
    p('The period agreed for lease is {{lease_period}} with effect from {{lease_from}} to {{lease_to}}.'),
  ] },
  { key: 'paragraph', lines: [
    li('The LESSEE shall pay the LESSOR on or before the {{rent_due_day}} of the succeeding month a fixed monthly rent of {{monthly_rent}}. The lessee has paid an advance of {{security_deposit}} to the LESSOR as security deposit, which shall be refundable at the end of the lease period, subject to any adjustments for damages or unpaid dues.'),
    li('The Lessee shall allow the lessor or their Agents or representatives at all reasonable time to enter upon the demised premises to inspect the conditions thereof and the lessee shall make good all defect/loss caused due to any act of commission/omission or default on the part of the lessee within one month of the notice in writing by the Lessor.'),
    li('The Lease can be terminated either by the lessor or the lessee after giving {{notice_period}} notice in writing.'),
    li('The Lessee shall pay all water and electricity charges for units of the same actually consumed by the Lessee in the Demised Premises.'),
    li('The Lessor shall pay the property tax and urban tax in respect of the demised premises.'),
    li('The LESSEE shall at its own costs, charges and expenses carry out all internal repairs and maintenance to the demised premises and keep the demised premises in good condition.'),
    li('The lessee shall have the liberty to install equipment required for their business in the demised premises by making small alterations of and additions to the premises demised herein.'),
    li('The lessor shall permit the lessee to enjoy the demised premises quietly and peacefully without interruption or disturbance by them or by any person claiming through them.'),
    li('The lessee shall not sublet the demised premises to anybody.'),
    li('The lessee hereby agrees and undertakes to keep the lessor informed if there is any change in the constitution.'),
  ] },
  { key: 'paragraph', lines: [
    p('IN WITNESS WHEREOF, the parties hereto have set their hands and seal on this day, month, and year first above written.'),
  ] },
  // The schedule: a centred heading, then the address on its own line.
  { key: 'keyvalue', title: 'DESCRIPTION OF PROPERTY', align: 'center', rows: [
    { label: 'Full Address', value: '{{property_address}}' },
  ] },
  { key: 'signature', columns: 2, people: [
    { name: 'LESSOR', role: '{{lessor_name}}', din: '', note: '' },
    { name: 'LESSEE', role: '{{lessee_name}}', din: '', note: '' },
  ] },
  { key: 'keyvalue', title: 'WITNESSES', rows: [
    { label: '1. Name', value: '{{witness1_name}}' },
    { label: 'Address', value: '{{witness1_address}}' },
    { label: 'Contact No', value: '{{witness1_phone}}' },
    { label: 'Aadhaar No', value: '{{witness1_aadhaar}}' },
    { label: '2. Name', value: '{{witness2_name}}' },
    { label: 'Address', value: '{{witness2_address}}' },
    { label: 'Contact No', value: '{{witness2_phone}}' },
    { label: 'Aadhaar No', value: '{{witness2_aadhaar}}' },
  ] },
];

/**
 * EPF Letter — asking the RPFC to mark an auto-allotted code dormant.
 *
 * The reference letter's own wording: a company incorporated through
 * SPICe+ gets an EPF code at incorporation whether or not the Act applies
 * to it, and this is the letter that says so.
 */
export const EPF_LETTER: RawBlock[] = [
  { key: 'date', title: 'Date:', align: 'left' },
  { key: 'address', title: 'To,', lines: [
    p('The Regional Provident Fund Commissioner,', 'left'),
    p('EPFO Regional Office, {{epfo_office}}', 'left'),
  ] },
  { key: 'subject', align: 'left',
    title: 'Subject: Request for deactivation of auto-allotted EPF Code No. {{epf_code}} — Act not applicable' },
  { key: 'paragraph', lines: [p('Respected Sir/Madam,', 'left')] },
  { key: 'paragraph', lines: [
    p('Our company, {{company_name}} (CIN: {{cin}}), was incorporated on {{incorporation_date}} through the SPICe+ process, and EPF Code No. {{epf_code}} was automatically allotted at incorporation. The company currently has no employees other than its {{director_count}} directors, and therefore does not meet the threshold of twenty employees under Section 1(3)(b) of the EPF & MP Act, 1952. We have also not opted for voluntary coverage. We therefore request you to kindly mark the above code as non-operational/dormant and take on record that no filing or contribution liability arises at present. We undertake to commence compliance as soon as the Act becomes applicable to us.'),
  ] },
  { key: 'paragraph', lines: [p('Thanking you,', 'left')] },
  { key: 'signature', title: 'Yours faithfully,', columns: 1, people: [
    { name: '{{signatory_name}}', role: 'Director', din: '{{signatory_din}}', note: 'For {{company_name}}', rule: true },
  ] },
];
