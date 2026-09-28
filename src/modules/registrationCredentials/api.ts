/**
 * Registration credentials client (MSME, Shops, IEC, PF, ESI, E-Invoice,
 * E-Way Bill). A record never carries the password — `password_present` says
 * whether one is stored; `reveal` fetches it on demand, audited server-side.
 */
import { api } from '@/services/api';

export type RegistrationMode = 'new' | 'existing';

export interface RegistrationFieldSpec {
  key: string;
  label: string;
  kind?: 'text' | 'email' | 'phone' | 'gstin' | 'textarea' | 'select';
  options?: string[];
  placeholder?: string;
  required?: boolean | RegistrationMode[];
  modes?: RegistrationMode[];
  prefill?: 'gstin' | 'contact_number' | 'email';
  mono?: boolean;
}

export interface RegistrationSpec {
  code: string;
  title: string;
  modes?: { key: RegistrationMode; label: string; hint: string }[];
  fields: RegistrationFieldSpec[];
  password?: { label: string; required: boolean | RegistrationMode[]; modes?: RegistrationMode[] };
}

export interface RegistrationCredential {
  mode: RegistrationMode | null;
  fields: Record<string, string>;
  password_present: boolean;
  updated_at: string;
}

const base = (type: string, clientId: string) => `/api/registration-credentials/${type}/${clientId}`;

export const registrationCredentialsApi = {
  get: (type: string, clientId: string) =>
    api.get<{ spec: RegistrationSpec; record: RegistrationCredential | null }>(base(type, clientId)),
  save: (type: string, clientId: string, input: { mode?: RegistrationMode | null; fields: Record<string, string>; password?: string }) =>
    api.put<{ record: RegistrationCredential }>(base(type, clientId), input),
  remove: (type: string, clientId: string) => api.delete<{ deleted: true }>(base(type, clientId)),
  reveal: (type: string, clientId: string, action: 'show' | 'copy') =>
    api.post<{ value: string }>(`${base(type, clientId)}/reveal`, { action }),
};

/** Registrations that have a credentials card. */
export const CREDENTIAL_REGISTRATIONS = new Set([
  'msme-udyam', 'shops-establishment', 'import-export-code', 'pf', 'esi', 'e-invoice', 'e-way-bill',
]);

export const inMode = (modes: RegistrationMode[] | undefined, mode: RegistrationMode | null) =>
  !modes || !mode || modes.includes(mode);
export const requiredIn = (req: boolean | RegistrationMode[] | undefined, mode: RegistrationMode | null) =>
  req === true || (Array.isArray(req) && !!mode && req.includes(mode));
