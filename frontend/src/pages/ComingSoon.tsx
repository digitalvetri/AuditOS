import { Link } from 'react-router-dom';

/** A feature with an address but no screen yet — says so plainly. */
export function ComingSoonPage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="max-w-[560px] mx-auto">
      <div className="bg-white border border-neutral-200 rounded p-6">
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">Coming soon</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">{title}</h1>
        <p className="text-13 text-neutral-500 mt-2">
          {body ?? 'This part of AuditOS is not available yet.'}
        </p>
        <div className="mt-4">
          <Link to="/" className="text-13 text-gold hover:text-gold-hover">
            Return to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
