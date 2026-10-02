/**
 * The RESOLUTIONS: board resolutions (appointment, resignation, authorised
 * signatory) and the shareholders' ordinary resolution.
 *
 * A resolution is a certified-true-copy header followed by RESOLVED clauses
 * and the signatures that certify it — the same three parts every time, with
 * the clauses themselves taken from the reference documents.
 */
import type { RawBlock } from '../model';

const p = (html: string, align: 'justify' | 'left' | 'center' = 'justify') => ({ align, html });

/** The header every board resolution opens with. */
const CTC = (extra = '') =>
  ({ key: 'heading' as const, variant: 'subtitle' as const, align: 'justify' as const,
    title: `CERTIFIED TRUE COPY OF THE RESOLUTION PASSED AT THE MEETING OF THE BOARD OF DIRECTORS OF {{company_name}}${extra} HELD ON {{meeting_date}} AT {{meeting_place}} AT {{meeting_time}}` });

export const BOARD_RESOLUTION_APPOINTMENT: RawBlock[] = [
  CTC(' [CIN {{cin}}]'),
  { key: 'paragraph', lines: [
    p('<b>RESOLVED THAT</b> pursuant to the provisions of the Companies Act, 2013 and the rules made thereunder, approval be and is hereby given to apply for the allotment of Director Identification Number (DIN) in the name of {{appointee_name}}, who has consented to act as a Director of the Company.'),
  ] },
  { key: 'paragraph', lines: [
    p('<b>RESOLVED FURTHER THAT</b> {{authorised_director}}, Director of the Company, be and is hereby authorized to digitally sign and submit Form DIR-3 with the Registrar of Companies and to do all such acts, deeds, and things as may be necessary in this regard.'),
  ] },
  // Each signatory carries the company line above their own, and they stack
  // one under the other with a space between — as the resolution is signed.
  { key: 'signature', title: 'For and on behalf of', columns: 1, people: [
    { name: '{{signatory1_name}}', role: 'Director', din: '{{signatory1_din}}', note: '{{company_name}}' },
    { name: '{{signatory2_name}}', role: 'Director', din: '{{signatory2_din}}', note: '{{company_name}}' },
  ] },
];

export const BOARD_RESOLUTION_RESIGNATION: RawBlock[] = [
  CTC(),
  { key: 'paragraph', lines: [
    p('<b>RESOLVED THAT</b> the resignation of {{resigning_director}}, Director of the Company, having DIN {{resigning_din}}, be and is hereby accepted with effect from {{effective_date}}.'),
  ] },
  { key: 'paragraph', lines: [
    p('<b>RESOLVED FURTHER THAT</b> the Board places on record its deep appreciation for the valuable contributions made by {{resigning_director}} during his/her tenure as Director of the Company.'),
  ] },
  { key: 'paragraph', lines: [
    p('<b>RESOLVED FURTHER THAT</b> {{authorised_director}}, Director of the Company, be and is hereby authorized to file the necessary e-Form DIR-12 with the Registrar of Companies and to do all such acts, deeds, and things as may be necessary to give effect to this resolution.'),
  ] },
  // Company line, a line to sign on, then who signed — the reference
  // resolution's own sign-off.
  { key: 'signature', title: 'For and on behalf of', columns: 1, people: [
    { name: '{{signatory1_name}}', role: 'Director', din: '{{signatory1_din}}', note: '{{company_name}}', rule: true },
  ] },
];

export const BOARD_RESOLUTION_AUTHORISED_SIGNATORY: RawBlock[] = [
  { key: 'heading', title: 'BOARD RESOLUTION FOR APPOINTING AN AUTHORIZED SIGNATORY', variant: 'title', align: 'center' },
  { key: 'heading', variant: 'subtitle', align: 'justify',
    title: 'CERTIFIED TRUE COPY OF THE RESOLUTION PASSED AT THE MEETING OF THE BOARD OF DIRECTORS OF {{company_name}} HELD ON {{meeting_date}} AT {{meeting_time}} AT THE REGISTERED OFFICE OF THE COMPANY AT {{registered_office}}.' },
  { key: 'paragraph', lines: [
    p('<b>RESOLVED THAT</b> {{director_name}}, Director of the Company, be and is hereby appointed as the Authorized Signatory of the Company for the purpose of executing, signing, and submitting all necessary documents, agreements, contracts, applications, and forms required for {{purpose}} on behalf of the Company.'),
  ] },
  { key: 'paragraph', lines: [
    p('<b>RESOLVED FURTHER THAT</b> {{director_name}} be and is hereby authorized to represent the Company before any government authorities, regulatory bodies, financial institutions, or private entities, and to take all such actions as may be necessary, expedient, or incidental to give effect to this resolution.'),
  ] },
  { key: 'paragraph', lines: [
    p('<b>RESOLVED FURTHER THAT</b> any acts done, and documents signed or executed by {{director_name}} pursuant to this authority shall be binding on the Company as if done by the Board of Directors itself.'),
  ] },
  { key: 'paragraph', lines: [
    p('<b>RESOLVED FURTHER THAT</b> this resolution shall remain in force until explicitly revoked or modified by a subsequent resolution of the Board of Directors, and a copy of this resolution certified as true by any Director or the Company Secretary be forwarded to the concerned authorities/entities as and when required.'),
  ] },
  { key: 'signature', title: 'For {{company_name}}', columns: 1, people: [
    { name: '{{signatory1_name}}', role: '{{signatory1_designation}}', din: '{{signatory1_din}}', note: '' },
  ] },
  { key: 'placedate', title: '{{place}}', align: 'left' },
];

export const SHAREHOLDERS_RESOLUTION: RawBlock[] = [
  { key: 'heading', variant: 'subtitle', align: 'justify',
    title: 'Certified True Copy of the Resolution Passed at the Meeting of the Members of {{company_name}} held on {{meeting_date}} at {{meeting_place}} at {{meeting_time}}' },
  { key: 'heading', title: 'ORDINARY RESOLUTION FOR APPOINTMENT OF DIRECTOR', variant: 'subtitle', align: 'center' },
  { key: 'paragraph', lines: [
    p('“<b>RESOLVED THAT</b> pursuant to the provisions of Section 152 and other applicable provisions, if any, of the Companies Act, 2013, and the Articles of Association of the Company, {{appointee_name}} (DIN: {{appointee_din}}) who was recommended by the Board of Directors and has consented to act as a Director, be and is hereby appointed as a Director of the Company, liable to retire by rotation.”'),
  ] },
  { key: 'paragraph', lines: [
    p('“<b>RESOLVED FURTHER THAT</b> {{authorised_director}}, the director of the Company be and is hereby authorized to file the necessary e-forms with the Registrar of Companies and take all other steps necessary to give effect to this resolution.”'),
  ] },
  { key: 'signature', title: 'For {{company_name}}', columns: 1, people: [
    { name: '{{signatory1_name}}', role: 'Director', din: '{{signatory1_din}}', note: '' },
  ] },
];
