import { useEffect, useState } from 'react';
import { Modal, textareaClass } from '@/modules/workstation/components';
import { Button } from '@/components/Button';

/**
 * The app's confirm dialog — replaces `window.confirm`, which blocks the tab,
 * cannot be styled and is suppressed by some browsers/PWAs.
 *
 *   if (await confirmAction('Remove this notice?')) remove.mutate();
 *
 * One <ConfirmHost /> is mounted at the app root; `confirmAction` queues a
 * request to it and resolves true (confirmed) or false (cancelled/dismissed).
 * Without a mounted host (unit tests) it falls back to `window.confirm`.
 */
export interface ConfirmOptions {
  title?: string;
  /** Label of the confirming button. Defaults to "Confirm". */
  action?: string;
  /** Destructive actions draw the confirm button in the danger style (default true). */
  danger?: boolean;
}
interface Request extends ConfirmOptions {
  message: string;
  /** Set for `promptText`: the dialog shows a text box and resolves its value. */
  prompt?: boolean;
  resolve: (value: string | null) => void;
}

let push: ((r: Request) => void) | null = null;

export function confirmAction(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  if (!push) return Promise.resolve(typeof window !== 'undefined' ? window.confirm(message) : false);
  return new Promise((resolve) => push!({ message, ...opts, resolve: (v) => resolve(v !== null) }));
}

/**
 * Ask for a short reason ("Why is this task being cancelled?"). Resolves the
 * text (possibly empty) on confirm, or null when dismissed — the same contract
 * as `window.prompt`, which it replaces.
 */
export function promptText(message: string, opts: ConfirmOptions = {}): Promise<string | null> {
  if (!push) return Promise.resolve(typeof window !== 'undefined' ? window.prompt(message) : null);
  return new Promise((resolve) => push!({ message, prompt: true, danger: false, action: 'Continue', ...opts, resolve }));
}

/** Guess a short verb for the button from the message ("Remove …?" → "Remove"). */
function verbOf(message: string): string {
  const m = /^(Remove|Delete|Revoke|Lock|Change|Make|Read|Split|Reset|Discard|Cancel|Archive)\b/i.exec(message.trim());
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : 'Confirm';
}

export function ConfirmHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    return () => { push = null; };
  }, []);
  const cur = queue[0];
  const close = (ok: boolean) => {
    if (!cur) return;
    cur.resolve(ok ? (cur.prompt ? text : '') : null);
    setText('');
    setQueue((q) => q.slice(1));
  };
  if (!cur) return null;
  const verb = cur.action ?? verbOf(cur.message);
  const danger = cur.danger ?? /^(Remove|Delete|Revoke|Discard)/i.test(verb);
  return (
    <Modal
      open
      title={cur.title ?? (cur.prompt ? 'Add a reason' : 'Are you sure?')}
      onClose={() => close(false)}
      width="w-[440px]"
      footer={(
        <>
          <Button variant="secondary" size="sm" onClick={() => close(false)}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            size="sm"
            className={danger ? '!bg-danger !text-white !border-danger hover:!opacity-90' : ''}
            onClick={() => close(true)}
          >
            {verb}
          </Button>
        </>
      )}
    >
      <p className="text-13 text-neutral-700 leading-relaxed">{cur.message}</p>
      {cur.prompt ? (
        <textarea
          aria-label={cur.message}
          className={textareaClass + ' mt-3 min-h-[72px]'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) close(true); }}
        />
      ) : null}
    </Modal>
  );
}
