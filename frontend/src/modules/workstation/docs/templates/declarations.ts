/**
 * The DECLARATIONS a third party signs: the authorised-signatory declaration
 * for a partnership or LLP, and the two no-objection certificates — one for a
 * GST registration, one for an incorporation.
 */
import type { RawBlock } from '../model';

const p = (html: string, align: 'justify' | 'left' | 'center' = 'justify') => ({ align, html });

export const AUTHORISED_SIGNATORY_DECLARATION: RawBlock[] = [
  { key: 'heading', title: '{{firm_name}}', variant: 'title', align: 'center' },
  { key: 'address', lines: [
    p('{{firm_address}}', 'center'),
    p('Ph: {{firm_phone}}', 'center'),
  ] },
  { key: 'date', title: 'Date:', align: 'left' },
  { key: 'heading', title: 'DECLARATION FOR AUTHORISED SIGNATORY', variant: 'subtitle', align: 'center' },
  { key: 'paragraph', lines: [
    p('This is to certify that {{signatory_name}} is an authorized representative of {{firm_name}}, holding the authority to sign documents, contracts, agreements, and other official paperwork on behalf of the firm.'),
  ] },
  { key: 'paragraph', lines: [
    p('He/She shall also be the authorized representative for signing of GST related compliances and bank account compliances.'),
  ] },
  { key: 'paragraph', lines: [
    p('{{signatory_name}}’s authorization is effective immediately and will remain valid until further notice. Any actions or documents signed by him/her are considered valid and binding for the firm.'),
  ] },
  { key: 'paragraph', lines: [p('Thank you for your attention to this matter.')] },
  // The partners sign two to a row, each as 'Name: …' over 'DIN: …'.
  { key: 'signature', variant: 'named', columns: 2, people: [
    { name: '{{partner1_name}}', role: '', din: '{{partner1_din}}', note: '' },
    { name: '{{partner2_name}}', role: '', din: '{{partner2_din}}', note: '' },
    { name: '{{partner3_name}}', role: '', din: '{{partner3_din}}', note: '' },
    { name: '{{partner4_name}}', role: '', din: '{{partner4_din}}', note: '' },
  ] },
  { key: 'heading', title: 'ACCEPTANCE AS AN AUTHORISED SIGNATORY', variant: 'subtitle', align: 'center' },
  { key: 'paragraph', lines: [
    p('I, {{signatory_name}}, hereby solemnly accord my acceptance to act as an authorized signatory for the above-referred business and all my acts shall be binding on the business.'),
  ] },
  { key: 'signature', columns: 1, people: [
    { name: '{{signatory_name}}', role: '', din: '{{signatory_din}}', note: '' },
  ] },
];

export const NOC_GST: RawBlock[] = [
  { key: 'address', title: 'From,', lines: [
    p('{{owner_name}}', 'left'),
    p('{{owner_relation}}', 'left'),
    p('{{property_address}}', 'left'),
  ] },
  { key: 'address', title: 'To,', lines: [
    p('The Officer,', 'left'),
    p('Goods and Service Tax Office – CBIC.', 'left'),
  ] },
  { key: 'paragraph', lines: [p('Respected Sir/Madam,', 'left')] },
  { key: 'subject', title: 'Sub: No objection for use of property', align: 'center' },
  { key: 'paragraph', lines: [
    p('I am the owner and landlord of the property at {{property_address}}. The Proprietorship Concern, {{concern_name}} run by Proprietor {{proprietor_name}} has proposed to have its registered office and the principal place of business at the above mentioned property, owned by me.'),
  ] },
  { key: 'paragraph', lines: [
    p('I hereby declared that I have no objection for my property being used as registered office of the company.'),
  ] },
  { key: 'keyvalue', title: 'Details of the Organisation', rows: [
    { label: 'Name of the concern', value: '{{concern_name}}' },
    { label: 'Name of Proprietor', value: '{{proprietor_name}}' },
    { label: 'PAN of the Proprietor', value: '{{pan}}' },
    { label: 'Nature of Business', value: '{{nature_of_business}}' },
  ] },
  { key: 'paragraph', lines: [p('Thanking You', 'center')] },
  // The sign-off sits on the right; the date and place return to the left,
  // as the reference certificate is laid out.
  { key: 'signature', title: 'Yours truly,', align: 'right', columns: 1, people: [
    { name: '{{owner_name}}', role: '', din: '', note: '' },
  ] },
  { key: 'placedate', title: '{{place}}', align: 'left' },
  { key: 'witness', people: [
    { name: '', role: '', din: '', note: 'Witness 1:' },
    { name: '', role: '', din: '', note: 'Witness 2:' },
  ] },
];

export const NOC_INCORPORATION: RawBlock[] = [
  { key: 'heading', title: 'TO WHOMSOEVER IT MAY CONCERN', variant: 'title', align: 'center' },
  { key: 'paragraph', lines: [
    p('This is to certify that I, {{owner_names}}, owner of the property bearing address {{property_address}}, have permitted and allowed the following directors/shareholders for operating and conducting their business with the name and style as stated below from the address mentioned above, and the consent is provided without any consideration paid by any of the directors or the shareholders of the said company.'),
  ] },
  { key: 'paragraph', lines: [
    p('The Company will be registered in the name and style of {{company_name}}, or any other name as the members decide in this matter.'),
  ] },
  { key: 'paragraph', lines: [p('The following are the directors/shareholders of the company:', 'left')] },
  // Two names, each on its own centred line, as the reference NOC lists them.
  { key: 'paragraph', lines: [p('{{directors}}', 'center'), p('{{directors2}}', 'center')] },
  { key: 'paragraph', lines: [
    p('I further state that I have no objection if the company uses the address of the said premises as their mailing address. This is a no objection certificate issued for company registration.'),
  ] },
  // The NOC's own sign-off: Signature / Name / Date / Place, stacked, once
  // per owner — the order the reference document uses.
  { key: 'signature', variant: 'stacked', columns: 1, people: [
    { name: '{{owner1_name}}', role: '{{place}}', din: '', note: '' },
    { name: '{{owner2_name}}', role: '{{place}}', din: '', note: '' },
  ] },
];
