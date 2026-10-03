/**
 * UI-BUILD-PROMPT §6 Card.
 *
 *   <Card title="Expenses to action" action={{ label: 'Open Queue', href: '/expenses' }}>
 *
 * A floating white card (`.dash-card`, globals.css) with 20px padding. Title
 * 15px 600 on the left; optional action link on the right in the brand
 * navy with a ChevronRight.
 *
 * Every card renders loading / empty / error states. Loading is a static
 * border-coloured block — no shimmer animation.
 */
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

interface Action {
  label: string;
  href: string;
}
interface Props {
  title: string;
  /** A second line under the title. */
  subtitle?: string;
  /** A small icon in a tinted square before the title. */
  icon?: ReactNode;
  /** A small green status pill beside the title (e.g. "Live"). */
  badge?: string;
  action?: Action;
  className?: string;
  children: ReactNode;
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyMessage?: string;
  'data-testid'?: string;
}

export function Card({
  title, subtitle, icon, badge, action, className = '', children, loading, error, empty, emptyMessage,
  ...rest
}: Props) {
  return (
    <section
      className={'dash-card p-5 ' + className}
      data-testid={rest['data-testid']}
    >
      <header className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-3 min-w-0">
          {icon ? (
            <span className="h-9 w-9 shrink-0 rounded-lg inline-flex items-center justify-center bg-[#e9f9f1] text-[#047857] ring-1 ring-inset ring-[#cdeede]">
              {icon}
            </span>
          ) : null}
          <div className="min-w-0">
            <h2 className="text-15 font-semibold text-ink tracking-[-0.005em] truncate">{title}</h2>
            {subtitle ? <p className="text-12 text-inkMuted truncate">{subtitle}</p> : null}
          </div>
        </div>
        {badge ? (
          <span className="shrink-0 inline-flex items-center gap-2 h-6 px-3 rounded-full text-11 font-semibold text-[#047857] bg-[#e9f9f1] ring-1 ring-inset ring-[#cdeede]">
            <span className="rounded-full" style={{ background: '#10b981', width: 6, height: 6 }} />{badge}
          </span>
        ) : null}
        {action ? (
          <Link
            to={action.href}
            className="inline-flex items-center gap-1 h-7 px-3 rounded-full text-12 font-medium text-primary bg-[#f1edff] hover:bg-[#e0d8f8] transition-colors"
          >
            {action.label}
            <ChevronRight size={14} strokeWidth={1.75} />
          </Link>
        ) : null}
      </header>
      {loading ? <LoadingBlock /> :
       error ? <ErrorBlock message={error} /> :
       empty ? <EmptyBlock message={emptyMessage ?? 'Nothing to show yet.'} /> :
       children}
    </section>
  );
}

function LoadingBlock() {
  // Static border-coloured block — NO shimmer. UI-BUILD-PROMPT §6 rule.
  return <div className="h-16 rounded-md bg-border" aria-label="Loading" />;
}
function ErrorBlock({ message }: { message: string }) {
  return (
    <div className="text-13 text-danger" role="alert">
      {message}
    </div>
  );
}
function EmptyBlock({ message }: { message: string }) {
  return <div className="text-13 text-inkMuted">{message}</div>;
}
