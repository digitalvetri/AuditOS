import type { ReactNode } from 'react';
import { Modal, fieldErrors } from '@/modules/workstation/components';

/**
 * A create dialog wired to one POST. Field errors come back from the server.
 *
 * Shared by every bookkeeping create surface (the list pages and the client
 * list's "Add client"), so a validation message renders identically wherever
 * it is raised.
 */
export function CreateModal({
  open, title, onClose, onSubmit, children, pending, err, submitLabel = 'Create',
}: {
  open: boolean; title: string; onClose: () => void; onSubmit: () => void;
  children: ReactNode; pending: boolean; err: unknown; submitLabel?: string;
}) {
  const errors = fieldErrors(err);
  // A non-field error (409 engagement_exists, 403 forbidden) carries no
  // `details` map, so it would otherwise vanish. Surface it on its own.
  const message = Object.keys(errors).length === 0 ? (err as Error | null)?.message : null;

  return (
    <Modal
      open={open} title={title} onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="h-8 px-3 text-13 border border-neutral-300 rounded hover:bg-neutral-50">
            Cancel
          </button>
          <button
            onClick={onSubmit} disabled={pending}
            className="h-8 px-3 text-13 bg-neutral-900 text-white rounded hover:bg-neutral-800 disabled:opacity-50"
          >
            {pending ? 'Saving…' : submitLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {children}
        {Object.entries(errors).map(([k, v]) => (
          <p key={k} className="text-12 text-red-700">{k}: {v}</p>
        ))}
        {message ? <p className="text-12 text-red-700">{message}</p> : null}
      </div>
    </Modal>
  );
}
