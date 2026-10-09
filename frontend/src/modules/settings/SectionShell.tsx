/**
 * Small wrapper each Settings section reuses. Header + optional Add button +
 * body slot. Keeps every section's chrome identical without a big framework.
 */
import type { ReactNode } from 'react';
import {
  BadgePercent, Briefcase, Building2, CalendarDays, CalendarRange, KeyRound, MapPin, Receipt, Settings, ShieldCheck, Users,
} from 'lucide-react';
import { Button } from '@/components/Button';

/** A tinted icon square per section, keyed by its title. */
const LOOK: Record<string, { Icon: typeof Settings; bg: string; fg: string }> = {
  'Departments': { Icon: Building2, bg: '#efeafd', fg: '#6941d9' },
  'Designations': { Icon: Briefcase, bg: '#f5f1ff', fg: '#5b33c4' },
  'Work locations': { Icon: MapPin, bg: '#e9f9f1', fg: '#047857' },
  'Holiday calendar': { Icon: CalendarDays, bg: '#fff7e6', fg: '#b45309' },
  'Leave types': { Icon: CalendarRange, bg: '#e9f9f1', fg: '#047857' },
  'Expense categories': { Icon: Receipt, bg: '#fff7e6', fg: '#b45309' },
  'Statutory rates': { Icon: BadgePercent, bg: '#f5f1ff', fg: '#5b33c4' },
  'Users': { Icon: Users, bg: '#f5f1ff', fg: '#5b33c4' },
  'Roles & permissions': { Icon: KeyRound, bg: '#efeafd', fg: '#6941d9' },
  'Data protection': { Icon: ShieldCheck, bg: '#e9f9f1', fg: '#047857' },
};

interface Props {
  title: string;
  description?: string;
  addLabel?: string;
  onAdd?: () => void;
  children: ReactNode;
}

export function SectionShell({ title, description, addLabel, onAdd, children }: Props) {
  const look = LOOK[title] ?? { Icon: Settings, bg: '#f1f5f9', fg: '#475569' };
  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="h-10 w-10 shrink-0 rounded-lg inline-flex items-center justify-center" style={{ background: look.bg, color: look.fg }} aria-hidden>
            <look.Icon size={18} strokeWidth={1.9} />
          </span>
          <div className="min-w-0">
            <h2 className="text-18 font-semibold text-neutral-900">{title}</h2>
            {description ? <p className="text-13 text-neutral-500 mt-px">{description}</p> : null}
          </div>
        </div>
        {onAdd && addLabel ? (
          <Button variant="primary" onClick={onAdd} data-testid={`settings-add`}>
            {addLabel}
          </Button>
        ) : null}
      </header>
      {children}
    </section>
  );
}
