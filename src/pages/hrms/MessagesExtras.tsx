/**
 * WhatsApp-style pieces for /hrms/messages: new chat / new group, the
 * conversation menu (group info, clear chat, delete chat, exit / delete
 * group), the group info panel with admin actions, the per-message menu
 * (reply, delete for me / for everyone), and voice notes (recorder + player).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check, CheckCheck, ChevronDown, Crown, Download, EllipsisVertical, Info, LogOut, Mic, MessageSquarePlus, Pause, Play, Search,
  Send, Trash2, UserMinus, UserPlus, Users, X,
} from 'lucide-react';
import { messagesApi, type ChatAttachment, type ChatListItem, type ChatMessageWithAuthor } from '@/modules/messages/api';
import { useToast } from '@/components/Toast';
import { useAuth } from '@/platform/auth/AuthContext';

const useMyEmployeeId = () => useAuth().session?.employee?.id ?? '';

const menuItem = 'w-full text-left flex items-center gap-2 px-3 py-2 text-13 text-ink hover:bg-canvas';
const dangerItem = menuItem + ' text-danger';

/**
 * A small popover menu anchored to its trigger. It renders into <body> with
 * fixed positioning, so a scrolling message list can never clip it, and it
 * opens upward when there is no room below. Closes on outside click / Escape /
 * scroll.
 */
function Popover({ trigger, children, align = 'right' }: { trigger: (open: () => void) => React.ReactNode; children: (close: () => void) => React.ReactNode; align?: 'left' | 'right' }) {
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const anchor = useRef<HTMLSpanElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const close = () => setPos(null);
  const open = () => {
    if (pos) return close();
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const up = window.innerHeight - r.bottom < 240;
    setPos({ top: up ? r.top - 4 : r.bottom + 4, left: align === 'right' ? r.right : r.left, up });
  };
  useEffect(() => {
    if (!pos) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !anchor.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close);
    };
  }, [pos]);
  return (
    <span className="relative inline-flex" ref={anchor}>
      {trigger(open)}
      {pos ? createPortal(
        <div ref={menu} role="menu"
          className="fixed z-[60] min-w-[210px] bg-surface border border-border rounded-md shadow-card py-1"
          style={{
            top: pos.top, left: pos.left,
            transform: `translate(${align === 'right' ? '-100%' : '0'}, ${pos.up ? '-100%' : '0'})`,
          }}>
          {children(close)}
        </div>,
        document.body,
      ) : null}
    </span>
  );
}

function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" role="dialog" aria-modal aria-label={title} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-[460px] max-h-[88dvh] flex flex-col bg-surface rounded-lg shadow-card border border-border">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="text-15 font-semibold text-ink">{title}</div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-inkMuted hover:text-ink"><X size={18} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4">{children}</div>
        {footer ? <div className="px-4 py-3 border-t border-border flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

function Confirm({ title, body, action, danger = true, onCancel, onConfirm, busy }: { title: string; body: string; action: string; danger?: boolean; onCancel: () => void; onConfirm: () => void; busy?: boolean }) {
  return (
    <Modal title={title} onClose={onCancel} footer={<>
      <button type="button" className="h-9 px-4 text-13 rounded-md border border-border hover:bg-canvas" onClick={onCancel}>Cancel</button>
      <button type="button" disabled={busy} className={'h-9 px-4 text-13 rounded-md text-white disabled:opacity-50 ' + (danger ? 'bg-danger hover:opacity-90' : 'bg-primary hover:bg-primaryHover')} onClick={onConfirm}>{busy ? 'Working…' : action}</button>
    </>}>
      <p className="text-13 text-inkMuted">{body}</p>
    </Modal>
  );
}

function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  return !w.length ? '?' : w.length === 1 ? w[0].slice(0, 2).toUpperCase() : (w[0][0] + w[w.length - 1][0]).toUpperCase();
}

/** Pick people from the firm — one for a chat, several for a group. */
function PeoplePicker({ multi, exclude = [], selected, onChange }: { multi: boolean; exclude?: string[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const q = useQuery({ queryKey: ['chats', 'people'], queryFn: messagesApi.people, staleTime: 5 * 60_000 });
  const [search, setSearch] = useState('');
  const people = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data?.items ?? []).filter((p) => !exclude.includes(p.id) && (!s || p.full_name.toLowerCase().includes(s) || (p.designation ?? '').toLowerCase().includes(s)));
  }, [q.data, search, exclude]);
  return (
    <div>
      <div className="relative mb-2">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-inkFaint" />
        <input autoFocus type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search people"
          className="w-full h-9 pl-9 pr-3 text-13 bg-canvas border border-border rounded-full focus:outline-none focus:border-primary" />
      </div>
      {q.isLoading ? <div className="text-13 text-inkMuted p-2">Loading…</div> : people.length === 0 ? <div className="text-13 text-inkMuted p-2">No one matches.</div> : (
        <ul className="divide-y divide-border">
          {people.map((p) => {
            const on = selected.includes(p.id);
            return (
              <li key={p.id}>
                <button type="button" onClick={() => onChange(multi ? (on ? selected.filter((x) => x !== p.id) : [...selected, p.id]) : [p.id])}
                  className={'w-full flex items-center gap-3 px-2 py-2 text-left rounded ' + (on ? 'bg-canvas' : 'hover:bg-canvas')}>
                  <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-primary text-white text-12 font-semibold shrink-0">{initials(p.full_name)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-13 font-medium text-ink truncate">{p.full_name}</span>
                    <span className="block text-11 text-inkMuted truncate">{p.designation ?? p.employee_code}</span>
                  </span>
                  {multi ? <input type="checkbox" readOnly checked={on} className="shrink-0" aria-label={`Select ${p.full_name}`} /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── New chat / new group ───────────────────────────────────────────────────
export function NewChatButton({ onOpened }: { onOpened: (chatId: string) => void }) {
  const [mode, setMode] = useState<'dm' | 'group' | null>(null);
  return (
    <>
      <Popover
        trigger={(open) => (
          <button type="button" onClick={open} aria-label="New chat" title="New chat or group"
            className="inline-flex items-center justify-center w-9 h-9 rounded-full text-inkMuted hover:text-ink hover:bg-canvas shrink-0">
            <MessageSquarePlus size={19} strokeWidth={1.75} />
          </button>
        )}
      >
        {(close) => (
          <>
            <button type="button" className={menuItem} onClick={() => { close(); setMode('dm'); }}><MessageSquarePlus size={15} /> New chat</button>
            <button type="button" className={menuItem} onClick={() => { close(); setMode('group'); }}><Users size={15} /> New group</button>
          </>
        )}
      </Popover>
      {mode ? <NewChatModal mode={mode} onClose={() => setMode(null)} onOpened={(id) => { setMode(null); onOpened(id); }} /> : null}
    </>
  );
}

function NewChatModal({ mode, onClose, onOpened }: { mode: 'dm' | 'group'; onClose: () => void; onOpened: (chatId: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string[]>([]);
  const [step, setStep] = useState<'people' | 'name'>('people');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const create = useMutation({
    mutationFn: () => (mode === 'dm' ? messagesApi.createDM(selected[0]) : messagesApi.createGroup(name.trim(), selected, description.trim() || undefined)),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ['chats', 'list'] }); onOpened(r.chat.id); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  if (mode === 'dm') {
    return (
      <Modal title="New chat" onClose={onClose}>
        <PeoplePicker multi={false} selected={selected} onChange={(ids) => { setSelected(ids); if (ids[0]) setTimeout(() => create.mutate(), 0); }} />
      </Modal>
    );
  }
  return (
    <Modal title={step === 'people' ? 'New group · add people' : 'New group · name it'} onClose={onClose} footer={step === 'people' ? (
      <>
        <span className="mr-auto self-center text-12 text-inkMuted">{selected.length} selected</span>
        <button type="button" disabled={!selected.length} onClick={() => setStep('name')} className="h-9 px-4 text-13 rounded-md text-white bg-primary hover:bg-primaryHover disabled:opacity-50">Next</button>
      </>
    ) : (
      <>
        <button type="button" onClick={() => setStep('people')} className="h-9 px-4 text-13 rounded-md border border-border hover:bg-canvas">Back</button>
        <button type="button" disabled={!name.trim() || create.isPending} onClick={() => create.mutate()} className="h-9 px-4 text-13 rounded-md text-white bg-primary hover:bg-primaryHover disabled:opacity-50">{create.isPending ? 'Creating…' : 'Create group'}</button>
      </>
    )}>
      {step === 'people' ? <PeoplePicker multi selected={selected} onChange={setSelected} /> : (
        <div className="space-y-3">
          <label className="block"><span className="block text-12 text-inkMuted mb-1">Group name *</span>
            <input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} className="w-full h-10 px-3 text-14 border border-border rounded-md focus:outline-none focus:border-primary" placeholder="e.g. Chennai audit team" /></label>
          <label className="block"><span className="block text-12 text-inkMuted mb-1">Description</span>
            <textarea value={description} maxLength={400} rows={2} onChange={(e) => setDescription(e.target.value)} className="w-full px-3 py-2 text-13 border border-border rounded-md focus:outline-none focus:border-primary" /></label>
          <p className="text-12 text-inkMuted">{selected.length + 1} members, including you. You will be the group admin.</p>
        </div>
      )}
    </Modal>
  );
}

// ── Conversation menu ──────────────────────────────────────────────────────
export function ThreadMenu({ chat, onGone }: { chat: ChatListItem; onGone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<null | 'clear' | 'hide' | 'leave' | 'delete'>(null);
  const [info, setInfo] = useState(false);
  const group = chat.type === 'group';
  const inGroup = group && chat.my_role !== null;
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['chats'] }); };
  const act = useMutation({
    mutationFn: (what: 'clear' | 'hide' | 'leave' | 'delete'): Promise<unknown> =>
      what === 'clear' ? messagesApi.clear(chat.id) : what === 'hide' ? messagesApi.hide(chat.id) : what === 'leave' ? messagesApi.leave(chat.id) : messagesApi.deleteGroup(chat.id),
    onSuccess: (_r, what) => {
      setConfirm(null); refresh();
      toast.push('success', { clear: 'Chat cleared.', hide: 'Chat deleted.', leave: 'You left the group.', delete: 'Group deleted for everyone.' }[what]);
      if (what === 'hide' || what === 'delete') onGone();
    },
    onError: (e: Error) => { setConfirm(null); toast.push('error', e.message); },
  });
  const texts = {
    clear: { title: 'Clear this chat?', body: 'All messages disappear for you. Others still have them.', action: 'Clear chat' },
    hide: { title: 'Delete this chat?', body: group && inGroup ? 'You will exit the group and it is removed from your list.' : 'It is removed from your list and cleared for you. It comes back if someone writes again.', action: 'Delete chat' },
    leave: { title: `Exit “${chat.display_name}”?`, body: 'You will stop receiving messages from this group. Your earlier messages stay.', action: 'Exit group' },
    delete: { title: `Delete “${chat.display_name}” for everyone?`, body: 'The group is removed for all members. Messages are kept on the server for audit.', action: 'Delete group' },
  } as const;
  return (
    <>
      <Popover trigger={(open) => (
        <button type="button" onClick={open} aria-label="Chat options" className="inline-flex items-center justify-center w-9 h-9 rounded-full text-inkMuted hover:text-ink hover:bg-canvas">
          <EllipsisVertical size={19} strokeWidth={1.75} />
        </button>
      )}>
        {(close) => (
          <>
            {group ? <button type="button" className={menuItem} onClick={() => { close(); setInfo(true); }}><Users size={15} /> Group info</button> : null}
            <button type="button" className={menuItem} onClick={() => { close(); setConfirm('clear'); }}><Trash2 size={15} /> Clear chat</button>
            {inGroup ? <button type="button" className={dangerItem} onClick={() => { close(); setConfirm('leave'); }}><LogOut size={15} /> Exit group</button> : null}
            {group && chat.my_role === 'admin' ? <button type="button" className={dangerItem} onClick={() => { close(); setConfirm('delete'); }}><Trash2 size={15} /> Delete group for everyone</button> : null}
            <button type="button" className={dangerItem} onClick={() => { close(); setConfirm('hide'); }}><Trash2 size={15} /> Delete chat</button>
          </>
        )}
      </Popover>
      {confirm ? <Confirm {...texts[confirm]} busy={act.isPending} onCancel={() => setConfirm(null)} onConfirm={() => act.mutate(confirm)} /> : null}
      {info ? <GroupInfo chatId={chat.id} onClose={() => setInfo(false)} onGone={onGone} /> : null}
    </>
  );
}

// ── Group info ─────────────────────────────────────────────────────────────
function GroupInfo({ chatId, onClose, onGone }: { chatId: string; onClose: () => void; onGone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['chats', 'info', chatId], queryFn: () => messagesApi.info(chatId) });
  const [adding, setAdding] = useState<string[] | null>(null);
  const [edit, setEdit] = useState<{ name: string; description: string } | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['chats'] }); };
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { refresh(); },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const info = q.data;
  const admin = info?.my_role === 'admin';
  const myId = useMyEmployeeId();
  return (
    <Modal title="Group info" onClose={onClose}>
      {!info ? <div className="text-13 text-inkMuted">{q.isError ? (q.error as Error).message : 'Loading…'}</div> : (
        <div className="space-y-4">
          <div className="text-center">
            <span className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary text-white"><Users size={28} /></span>
            {edit ? (
              <div className="mt-3 space-y-2 text-left">
                <input value={edit.name} maxLength={120} onChange={(e) => setEdit({ ...edit, name: e.target.value })} className="w-full h-9 px-3 text-14 border border-border rounded-md" />
                <textarea value={edit.description} maxLength={400} rows={2} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder="Description" className="w-full px-3 py-2 text-13 border border-border rounded-md" />
                <div className="flex gap-2 justify-end">
                  <button type="button" className="h-8 px-3 text-12 rounded-md border border-border" onClick={() => setEdit(null)}>Cancel</button>
                  <button type="button" className="h-8 px-3 text-12 rounded-md text-white bg-primary disabled:opacity-50" disabled={!edit.name.trim()}
                    onClick={() => run.mutate(() => messagesApi.updateGroup(chatId, { name: edit.name.trim(), description: edit.description.trim() || null }), { onSuccess: () => { setEdit(null); void q.refetch(); } })}>Save</button>
                </div>
              </div>
            ) : (
              <>
                <div className="mt-2 text-16 font-semibold text-ink">{info.chat.display_name}</div>
                {info.chat.description ? <div className="text-12 text-inkMuted mt-0.5">{info.chat.description}</div> : null}
                <div className="text-12 text-inkMuted mt-0.5">Group · {info.members.length} members</div>
                {admin ? <button type="button" className="mt-2 text-12 text-primary hover:underline" onClick={() => setEdit({ name: info.chat.name ?? '', description: info.chat.description ?? '' })}>Edit name & description</button> : null}
              </>
            )}
          </div>

          {info.left ? <div className="text-12 text-center text-inkMuted">You are no longer a member of this group.</div> : null}

          {admin ? (
            adding ? (
              <div className="border border-border rounded-md p-2">
                <PeoplePicker multi exclude={info.members.map((m) => m.employee_id)} selected={adding} onChange={setAdding} />
                <div className="flex justify-end gap-2 mt-2">
                  <button type="button" className="h-8 px-3 text-12 rounded-md border border-border" onClick={() => setAdding(null)}>Cancel</button>
                  <button type="button" disabled={!adding.length || run.isPending} className="h-8 px-3 text-12 rounded-md text-white bg-primary disabled:opacity-50"
                    onClick={() => run.mutate(() => messagesApi.addMembers(chatId, adding), { onSuccess: () => { setAdding(null); void q.refetch(); } })}>Add {adding.length || ''}</button>
                </div>
              </div>
            ) : (
              <button type="button" className="w-full flex items-center gap-2 px-2 py-2 text-13 text-primary hover:bg-canvas rounded" onClick={() => setAdding([])}><UserPlus size={16} /> Add members</button>
            )
          ) : null}

          <ul className="divide-y divide-border">
            {info.members.map((m) => (
              <li key={m.employee_id} className="flex items-center gap-3 py-2">
                <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-neutral-500 text-white text-12 font-semibold shrink-0">{initials(m.full_name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-13 font-medium text-ink truncate">{m.full_name}</span>
                  <span className="block text-11 text-inkMuted truncate">{m.designation ?? m.employee_code}</span>
                </span>
                {m.role === 'admin' ? <span className="text-11 px-2 py-0.5 rounded-full bg-canvas text-primary border border-border">Group admin</span> : null}
                {admin && m.employee_id !== myId ? (
                  <Popover trigger={(open) => <button type="button" onClick={open} aria-label={`Options for ${m.full_name}`} className="w-7 h-7 inline-flex items-center justify-center text-inkMuted hover:text-ink"><ChevronDown size={16} /></button>}>
                    {(close) => (
                      <>
                        <button type="button" className={menuItem} onClick={() => { close(); run.mutate(() => messagesApi.setRole(chatId, m.employee_id, m.role === 'admin' ? 'member' : 'admin'), { onSuccess: () => void q.refetch() }); }}>
                          <Crown size={15} /> {m.role === 'admin' ? 'Dismiss as admin' : 'Make group admin'}
                        </button>
                        <button type="button" className={dangerItem} onClick={() => { close(); run.mutate(() => messagesApi.removeMember(chatId, m.employee_id), { onSuccess: () => void q.refetch() }); }}>
                          <UserMinus size={15} /> Remove from group
                        </button>
                      </>
                    )}
                  </Popover>
                ) : null}
              </li>
            ))}
          </ul>

          {info.my_role ? (
            <button type="button" className="w-full flex items-center gap-2 px-2 py-2 text-13 text-danger hover:bg-canvas rounded"
              onClick={() => run.mutate(() => messagesApi.leave(chatId), { onSuccess: () => { onClose(); } })}><LogOut size={16} /> Exit group</button>
          ) : null}
          {admin ? (
            <button type="button" className="w-full flex items-center gap-2 px-2 py-2 text-13 text-danger hover:bg-canvas rounded"
              onClick={() => { if (window.confirm('Delete this group for everyone?')) run.mutate(() => messagesApi.deleteGroup(chatId), { onSuccess: () => { onClose(); onGone(); } }); }}>
              <Trash2 size={16} /> Delete group for everyone
            </button>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

// ── Per-message menu ───────────────────────────────────────────────────────
const DELETE_FOR_EVERYONE_HOURS = 48;

export function MessageMenu({ chat, message, own, onReply }: { chat: ChatListItem; message: ChatMessageWithAuthor; own: boolean; onReply: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<'me' | 'everyone' | null>(null);
  const [info, setInfo] = useState(false);
  const fresh = Date.now() - new Date(message.created_at).getTime() <= DELETE_FOR_EVERYONE_HOURS * 3_600_000;
  const canEveryone = !message.deleted && ((own && fresh) || (chat.type === 'group' && chat.my_role === 'admin'));
  const del = useMutation({
    mutationFn: (scope: 'me' | 'everyone') => messagesApi.deleteMessage(chat.id, message.id, scope),
    onSuccess: () => { setConfirm(null); void qc.invalidateQueries({ queryKey: ['chats'] }); },
    onError: (e: Error) => { setConfirm(null); toast.push('error', e.message); },
  });
  return (
    <>
      <Popover align={own ? 'right' : 'left'} trigger={(open) => (
        <button type="button" onClick={open} aria-label="Message options" data-testid={`msg-menu-${message.id}`}
          className="w-6 h-6 inline-flex items-center justify-center rounded-full text-inkFaint hover:text-ink hover:bg-canvas opacity-60 group-hover/bubble:opacity-100 transition-opacity">
          <ChevronDown size={15} />
        </button>
      )}>
        {(close) => (
          <>
            {!message.deleted && (chat.type === 'dm' || chat.my_role !== null) ? <button type="button" className={menuItem} onClick={() => { close(); onReply(); }}>Reply</button> : null}
            {own && !message.deleted ? <button type="button" className={menuItem} onClick={() => { close(); setInfo(true); }}><Info size={15} /> Message info</button> : null}
            <button type="button" className={dangerItem} onClick={() => { close(); setConfirm('me'); }}><Trash2 size={15} /> Delete for me</button>
            {canEveryone ? <button type="button" className={dangerItem} onClick={() => { close(); setConfirm('everyone'); }}><Trash2 size={15} /> Delete for everyone</button> : null}
          </>
        )}
      </Popover>
      {confirm ? (
        <Confirm
          title={confirm === 'me' ? 'Delete for me?' : 'Delete for everyone?'}
          body={confirm === 'me' ? 'The message is removed from your view only.' : 'Everyone in the chat will see “This message was deleted”.'}
          action="Delete" busy={del.isPending} onCancel={() => setConfirm(null)} onConfirm={() => del.mutate(confirm)}
        />
      ) : null}
      {info ? <MessageInfoModal chat={chat} message={message} onClose={() => setInfo(false)} /> : null}
    </>
  );
}

const fmtWhen = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** WhatsApp-style "Message info": when it was sent, who has read it and when, and who hasn't yet. */
function MessageInfoModal({ chat, message, onClose }: { chat: ChatListItem; message: ChatMessageWithAuthor; onClose: () => void }) {
  const q = useQuery({ queryKey: ['chats', 'msg-info', message.id], queryFn: () => messagesApi.messageInfo(chat.id, message.id), refetchInterval: 5_000 });
  const d = q.data;
  const preview = message.body || (message.attachments[0]?.kind === 'audio' ? '🎤 Voice message' : message.attachments[0]?.kind === 'document' ? `📄 ${message.attachments[0].filename}` : message.attachments.length ? 'Photo' : '');
  return (
    <Modal title="Message info" onClose={onClose}>
      <div className="mb-4 rounded-md bg-canvas border border-border px-3 py-2 text-13 text-ink whitespace-pre-wrap break-words">{preview}</div>
      {!d ? <div className="text-13 text-inkMuted">{q.isError ? (q.error as Error).message : 'Loading…'}</div> : (
        <div className="space-y-4">
          <div className="flex items-center justify-between text-13"><span className="text-inkMuted">Sent</span><span className="text-ink">{fmtWhen(d.sent_at)}</span></div>
          <section>
            <div className="flex items-center gap-1.5 text-12 font-semibold text-primary mb-1"><CheckCheck size={15} /> Read by {chat.type === 'group' ? `(${d.read_by.length})` : ''}</div>
            {d.read_by.length === 0 ? <div className="text-12 text-inkMuted">Not read yet.</div> : (
              <ul className="divide-y divide-border">
                {d.read_by.map((r) => (
                  <li key={r.employee_id} className="flex items-center gap-3 py-2">
                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-primary text-white text-11 font-semibold shrink-0">{initials(r.full_name)}</span>
                    <span className="flex-1 text-13 text-ink truncate">{r.full_name}</span>
                    <span className="text-11 text-inkMuted tabular-nums">{fmtWhen(r.read_at!)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {d.not_read.length ? (
            <section>
              <div className="flex items-center gap-1.5 text-12 font-semibold text-inkMuted mb-1"><Check size={15} /> Delivered, not read yet ({d.not_read.length})</div>
              <ul className="divide-y divide-border">
                {d.not_read.map((r) => (
                  <li key={r.employee_id} className="flex items-center gap-3 py-2">
                    <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-neutral-400 text-white text-11 font-semibold shrink-0">{initials(r.full_name)}</span>
                    <span className="flex-1 text-13 text-ink truncate">{r.full_name}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

// ── Voice notes ────────────────────────────────────────────────────────────
const fmtDur = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Plays a voice note with a progress bar; the recorder's measured length is shown before playback. */
export function VoicePlayer({ attachment, own }: { attachment: ChatAttachment; own: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [len, setLen] = useState((attachment.duration_ms ?? 0) / 1000);
  const toggle = () => {
    const a = ref.current;
    if (!a) return;
    if (playing) a.pause(); else void a.play();
  };
  return (
    <div className="flex items-center gap-2 min-w-[220px] py-1">
      <audio ref={ref} src={attachment.url} preload="metadata"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setPos(0); }}
        onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; if (Number.isFinite(d) && d > 0) setLen(d); }} />
      <button type="button" onClick={toggle} aria-label={playing ? 'Pause voice message' : 'Play voice message'}
        className={'w-9 h-9 shrink-0 inline-flex items-center justify-center rounded-full text-white ' + (own ? 'bg-primary' : 'bg-neutral-600')}>
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>
      <input type="range" min={0} max={len || 1} step={0.1} value={Math.min(pos, len || 1)} aria-label="Seek"
        onChange={(e) => { const a = ref.current; if (a) { a.currentTime = Number(e.target.value); setPos(a.currentTime); } }}
        className="flex-1 accent-current" />
      <span className="text-11 tabular-nums text-inkMuted w-9 text-right">{fmtDur((playing || pos ? pos : len) * 1000)}</span>
    </div>
  );
}

/**
 * Record a voice note in the browser (MediaRecorder). Tap the mic to start,
 * then send or discard. Nothing is uploaded until Send.
 */
export function VoiceRecorder({ onSend, disabled }: { onSend: (blob: Blob, durationMs: number) => void; disabled?: boolean }) {
  const toast = useToast();
  const [state, setState] = useState<'idle' | 'recording'>('idle');
  const [elapsed, setElapsed] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const sendOnStop = useRef(false);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { stopTracks(); if (timer.current) window.clearInterval(timer.current); }, []);
  const stopTracks = () => rec.current?.stream.getTracks().forEach((t) => t.stop());

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast.push('error', 'This browser cannot record audio.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      r.onstop = () => {
        const ms = Date.now() - started.current;
        stopTracks();
        if (sendOnStop.current && chunks.current.length) onSend(new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }), ms);
        setState('idle'); setElapsed(0);
      };
      rec.current = r;
      started.current = Date.now();
      r.start(250);
      setState('recording');
      timer.current = window.setInterval(() => setElapsed(Date.now() - started.current), 200);
    } catch {
      toast.push('error', 'Microphone access was blocked. Allow it in the browser to send voice messages.');
    }
  };
  const finish = (send: boolean) => {
    sendOnStop.current = send;
    if (timer.current) { window.clearInterval(timer.current); timer.current = null; }
    rec.current?.stop();
  };

  if (state === 'recording') {
    return (
      <div className="flex-1 flex items-center gap-3 h-9 px-3 rounded-full bg-canvas border border-border" data-testid="voice-recording">
        <button type="button" onClick={() => finish(false)} aria-label="Discard recording" className="text-inkMuted hover:text-danger"><Trash2 size={18} /></button>
        <span className="inline-block w-2.5 h-2.5 rounded-full bg-danger animate-pulse" aria-hidden />
        <span className="text-13 tabular-nums text-ink">{fmtDur(elapsed)}</span>
        <span className="text-12 text-inkMuted flex-1">Recording…</span>
        <button type="button" onClick={() => finish(true)} aria-label="Send voice message" className="chat-send"><Send size={17} /></button>
      </div>
    );
  }
  return (
    <button type="button" onClick={start} disabled={disabled} aria-label="Record a voice message" title="Record a voice message" data-testid="composer-mic"
      className="chat-send">
      <Mic size={16} strokeWidth={2} />
    </button>
  );
}

/** A document in a chat: name, size, and a download link (documents always download). */
export function DocumentChip({ attachment }: { attachment: ChatAttachment }) {
  const ext = (attachment.filename.split('.').pop() ?? '').toUpperCase().slice(0, 4);
  const size = attachment.file_size < 1024 * 1024 ? `${Math.max(1, Math.round(attachment.file_size / 1024))} KB` : `${(attachment.file_size / (1024 * 1024)).toFixed(1)} MB`;
  return (
    <a href={attachment.url} download={attachment.filename} className="flex items-center gap-2 min-w-[220px] max-w-[320px] rounded border border-border bg-canvas px-2 py-2 hover:bg-surface" data-testid={`document-${attachment.id}`}>
      <span className="inline-flex items-center justify-center w-9 h-10 rounded bg-primary text-white text-[10px] font-bold shrink-0">{ext || 'FILE'}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-13 text-ink truncate" title={attachment.filename}>{attachment.filename}</span>
        <span className="block text-11 text-inkMuted">{size} · {ext}</span>
      </span>
      <Download size={16} className="text-inkMuted shrink-0" />
    </a>
  );
}
