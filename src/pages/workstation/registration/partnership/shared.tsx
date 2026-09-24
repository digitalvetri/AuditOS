import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workstationApi } from '@/modules/workstation/api';
import {
  gstRegApi, llpApi, makeRegistrationKeys, partnershipApi,
  type CaseStatus, type DueState, type EntityType, type RegistrationApi, type RegistrationKeys, type RegistrationKind, type RequirementType,
} from '@/modules/partnership/api';
import { fmtDate } from '@/lib/format';

/**
 * Shared bits for the registration case pages. Partnership Firm Registration
 * and LLP Registration are the same screens; the service context says which
 * one, and carries everything that differs.
 */
export interface RegistrationService {
  kind: RegistrationKind;
  label: string;
  base: string;
  api: RegistrationApi;
  keys: RegistrationKeys;
  stageOptions: { value: string; label: string }[];
  stageLabel: (s: string | null) => string;
}

function stageLabeller(options: { value: string; label: string }[]) {
  return (s: string | null) => options.find((o) => o.value === s)?.label ?? '—';
}

/** Derived from the Partnership PDF's two parts: deed drafting, then ROF filing. */
const PARTNERSHIP_STAGES = [
  { value: 'INFO_COLLECTION', label: 'Information Collection' },
  { value: 'DEED', label: 'Deed Drafting & Execution' },
  { value: 'ROF_FILING', label: 'ROF Filing' },
  { value: 'REGISTERED', label: 'Registered' },
];
/** The LLP source says only "two stages", so they carry no invented names. */
const LLP_STAGES = [
  { value: 'STAGE_1', label: 'Stage 1' },
  { value: 'STAGE_2', label: 'Stage 2' },
  { value: 'COMPLETED', label: 'Completed' },
];
/** GST Registration: collect → REG-01 filed → GSTIN issued. */
const GST_STAGES = [
  { value: 'INFO_COLLECTION', label: 'Information Collection' },
  { value: 'FILING', label: 'Filing (REG-01)' },
  { value: 'REGISTERED', label: 'Registered' },
];

export const SERVICES: Record<RegistrationKind, RegistrationService> = {
  PARTNERSHIP: {
    kind: 'PARTNERSHIP',
    label: 'Partnership Firm Registration',
    base: '/workstation/services/registration/partnership-firm',
    api: partnershipApi,
    keys: makeRegistrationKeys('partnership'),
    stageOptions: PARTNERSHIP_STAGES,
    stageLabel: stageLabeller(PARTNERSHIP_STAGES),
  },
  LLP: {
    kind: 'LLP',
    label: 'LLP Registration',
    base: '/workstation/services/registration/llp',
    api: llpApi,
    keys: makeRegistrationKeys('llp'),
    stageOptions: LLP_STAGES,
    stageLabel: stageLabeller(LLP_STAGES),
  },
  GST: {
    kind: 'GST',
    // GST Registration cases live inside the GST Compliance module under
    // the Registration tab — the module already owns /registration/gst and
    // its own "Clients" tab means the compliance roster, not registration
    // cases. Nesting under /registration keeps registration-case URLs like
    // /registration/gst/registration/clients/<id> distinct from the
    // compliance client roster at /registration/gst/clients.
    label: 'GST Registration',
    base: '/workstation/services/registration/gst/registration',
    api: gstRegApi,
    keys: makeRegistrationKeys('gst-registration'),
    stageOptions: GST_STAGES,
    stageLabel: stageLabeller(GST_STAGES),
  },
};

const ServiceContext = createContext<RegistrationService>(SERVICES.PARTNERSHIP);
export function ServiceProvider({ kind, children }: { kind: RegistrationKind; children: ReactNode }) {
  return <ServiceContext.Provider value={SERVICES[kind]}>{children}</ServiceContext.Provider>;
}
export const useSvc = () => useContext(ServiceContext);

/** Entity types a GST Registration case can be scoped to. */
export const ENTITY_TYPE_OPTIONS: { value: EntityType; label: string }[] = [
  { value: 'PROPRIETORSHIP', label: 'Proprietorship' },
  { value: 'PARTNERSHIP', label: 'Partnership Firm' },
  { value: 'LLP', label: 'LLP' },
  { value: 'PVT_LTD', label: 'Private Limited Company' },
];

export const CASE_STATUS_OPTIONS: { value: CaseStatus; label: string }[] = [
  { value: 'NOT_STARTED', label: 'Not Started' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'DOCUMENTS_PENDING', label: 'Documents Pending' },
  { value: 'UNDER_REVIEW', label: 'Under Review' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'QUERY', label: 'Query / Clarification' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'ON_HOLD', label: 'On Hold' },
];


export function RequirementTag({ value, condition }: { value: RequirementType; condition?: string | null }) {
  const cls =
    value === 'REQUIRED' ? 'text-neutral-900 border-neutral-400'
    : value === 'CONDITIONAL' ? 'text-amber border-amber'
    : 'text-neutral-500 border-neutral-300';
  const text = value === 'CONDITIONAL' && condition ? `Conditional · ${condition === 'RENTED' ? 'Rented' : 'Owned'}` : value.charAt(0) + value.slice(1).toLowerCase();
  return <span className={`inline-block px-1.5 h-5 leading-5 text-11 border rounded ${cls}`}>{text}</span>;
}

export function DueChip({ date, state }: { date: string | null; state: DueState }) {
  if (!date) return <span className="text-neutral-400">—</span>;
  const cls =
    state === 'overdue' ? 'text-red font-medium'
    : state === 'today' ? 'text-amber font-medium'
    : state === 'soon' ? 'text-amber'
    : 'text-neutral-700';
  const suffix = state === 'overdue' ? ' · Overdue' : state === 'today' ? ' · Due today' : state === 'soon' ? ' · Due soon' : '';
  return <span className={`text-13 whitespace-nowrap ${cls}`}>{fmtDate(date)}{suffix}</span>;
}

export function ProgressBar({ pct, className = 'w-24' }: { pct: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span className="flex-1 h-1.5 bg-neutral-200 rounded overflow-hidden">
        <span className="block h-full bg-gold" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </span>
      <span className="text-12 text-neutral-700 tabular-nums w-9 text-right">{pct}%</span>
    </span>
  );
}

export function useEmployees() {
  const q = useQuery({
    queryKey: ['workstation', 'assignable-employees'],
    queryFn: () => workstationApi.assignableEmployees(),
    staleTime: 5 * 60_000,
  });
  return (q.data?.items ?? []).map((e) => ({ value: e.id, label: e.full_name }));
}

export function EmployeeSelect({ value, onChange, placeholder = 'Unassigned', className = '' }: {
  value: string; onChange: (v: string) => void; placeholder?: string; className?: string;
}) {
  const options = useEmployees();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-8 px-2 text-13 bg-white text-neutral-900 border border-neutral-300 rounded focus:outline-none focus:border-gold ${className}`}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
