/**
 * The DIRECTOR-FACING letters: appointment, consent, non-disqualification,
 * resignation.
 *
 * Each is the reference document's own wording, with the particulars that
 * change per client as {{placeholders}} — the fields the document type
 * declares in ../registry.ts. Nothing here is a fixture: the reference
 * company and its directors never reach a new document.
 */
import type { RawBlock } from '../model';

const p = (html: string, align: 'justify' | 'left' | 'center' = 'justify') => ({ align, html });

export const APPOINTMENT_LETTER: RawBlock[] = [
  { key: 'date', title: 'Date:', align: 'left' },
  { key: 'address', title: 'To,', lines: [
    p('{{director_name}}', 'left'),
    p('DIN: {{din}}', 'left'),
    p('{{director_place}}', 'left'),
  ] },
  { key: 'subject', title: 'Subject: Appointment as Director', align: 'left' },
  { key: 'paragraph', lines: [p('Dear {{director_name}},')] },
  { key: 'paragraph', lines: [
    p('We are pleased to inform you that pursuant to the resolution passed by the Board of Directors at its meeting held on {{board_meeting_date}}, you have been appointed as an Additional Director of {{company_name}} holding DIN {{din}}, in accordance with the provisions of the Companies Act, 2013 and Articles of Association of the Company.'),
  ] },
  { key: 'paragraph', lines: [
    p('You shall hold office up to the ensuing General Meeting, at which your appointment shall be regularized subject to members’ approval.'),
  ] },
  { key: 'paragraph', lines: [
    p('We welcome you to the Board and look forward to your valuable guidance and support.'),
  ] },
  { key: 'signature', title: 'Yours faithfully,', columns: 1, people: [
    { name: 'For {{company_name}}', role: '', din: '', note: '' },
    { name: '{{signatory_name}}', role: '{{signatory_designation}}', din: '{{signatory_din}}', note: '' },
  ] },
];

export const CONSENT_LETTER: RawBlock[] = [
  { key: 'date', title: 'Date:', align: 'left' },
  { key: 'address', title: 'To,', lines: [
    p('The Board of Directors', 'left'),
    p('{{company_name}}', 'left'),
    p('{{registered_office}}', 'left'),
  ] },
  { key: 'subject', title: 'Subject: Consent to act as Director', align: 'left' },
  { key: 'paragraph', lines: [
    p('I, {{director_name}}, S/o {{father_name}}, residing at {{director_address}}, holding DIN {{din}}, hereby give my consent to act as a Director of {{company_name}}, pursuant to Section 152(5) and Rule 8 of the Companies (Appointment and Qualification of Directors) Rules, 2014.'),
  ] },
  { key: 'paragraph', lines: [
    p('I further confirm that I am not disqualified from being appointed as a Director under Section 164 of the Companies Act, 2013.'),
  ] },
  { key: 'signature', title: 'Yours faithfully,', columns: 1, people: [
    { name: '{{director_name}}', role: '(Signature)', din: '{{din}}', note: '' },
  ] },
  { key: 'keyvalue', title: '', rows: [
    { label: 'Address', value: '{{director_address}}' },
    { label: 'Email', value: '{{email}}' },
    { label: 'Mobile', value: '{{mobile}}' },
  ] },
];

export const NON_DISQUALIFICATION: RawBlock[] = [
  { key: 'date', title: 'Date:', align: 'left' },
  { key: 'address', title: 'To,', lines: [
    p('The Board of Directors', 'left'),
    p('{{company_name}}', 'left'),
    p('{{registered_office}}', 'left'),
  ] },
  { key: 'subject', title: 'Subject: Intimation of Non-Disqualification', align: 'left' },
  { key: 'paragraph', lines: [
    p('Pursuant to Section 164(2) and Rule 14(1) of the Companies (Appointment and Qualification of Directors) Rules, 2014, I, {{director_name}}, holding DIN {{din}}, do hereby confirm that I am not disqualified from being appointed as Director in terms of the Companies Act, 2013.'),
  ] },
  { key: 'paragraph', lines: [
    p('I further confirm that I have not been convicted of any offence in connection with the promotion, formation, or management of any company and that I have not been found guilty of any fraud or misfeasance.'),
  ] },
  { key: 'signature', title: 'Yours faithfully,', columns: 1, people: [
    { name: '{{director_name}}', role: '(Signature)', din: '{{din}}', note: '' },
  ] },
];

export const DIRECTOR_RESIGNATION: RawBlock[] = [
  { key: 'date', title: 'Date:', align: 'left' },
  { key: 'address', title: 'To,', lines: [
    p('The Board of Directors,', 'left'),
    p('{{company_name}}', 'left'),
    p('{{registered_office}}', 'left'),
  ] },
  { key: 'subject', title: 'Subject: Resignation from the Office of Director', align: 'center' },
  { key: 'paragraph', lines: [p('Dear Sir/Madam,')] },
  { key: 'paragraph', lines: [
    p('I, {{director_name}}, Director of {{company_name}}, bearing DIN {{din}}, hereby tender my resignation from the office of Director of the Company with effect from {{effective_date}}.'),
  ] },
  { key: 'paragraph', lines: [
    p('Kindly accept my resignation and file necessary forms with the Registrar of Companies (ROC) to that effect.'),
  ] },
  { key: 'paragraph', lines: [
    p('I hereby confirm that there are no material reasons for my resignation other than {{resignation_reason}}.'),
  ] },
  { key: 'paragraph', lines: [
    p('I sincerely thank the Board of Directors and the shareholders for the support extended during my tenure as Director of the Company.'),
  ] },
  { key: 'paragraph', lines: [
    p('Kindly acknowledge the receipt of this resignation letter and arrange to submit the necessary filings with ROC.'),
  ] },
  { key: 'signature', title: 'Yours faithfully,', columns: 1, people: [
    { name: '{{director_name}}', role: '', din: '{{din}}', note: '' },
  ] },
  { key: 'keyvalue', title: '', rows: [
    { label: 'Address', value: '{{director_address}}' },
    { label: 'Email', value: '{{email}}' },
  ] },
];
