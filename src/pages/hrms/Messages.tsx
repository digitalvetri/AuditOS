/**
 * /hrms/messages — messenger-style chat per §8.7.
 *
 * Reads as a messenger rather than a record screen: conversations on the left,
 * one conversation on the right, tailed bubbles on a tinted wallpaper, day
 * separators, and a composer pinned to the bottom. Desktop shows both panes;
 * a phone shows the list *or* the thread, since neither fits beside the other
 * at 320px.
 *
 * Scope cuts for this scaffold (documented in module handoff):
 *   Skipped: reactions, @mentions, in-conversation search, calls (messaging only).
 *   Included: text, images, documents, voice messages, reply-to, read
 *             receipts, unread counts, new chat / new group, group info and
 *             admin actions, clear / delete chat, exit / delete group, and
 *             delete for me / for everyone (MessagesExtras.tsx).
 */
import {
  useEffect, useMemo, useRef, useState,
  type ChangeEvent, type ClipboardEvent, type FormEvent,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  messagesApi,
  type ChatAttachment, type ChatListItem, type ChatMessageWithAuthor,
} from '@/modules/messages/api';
import { fmtTime } from '@/lib/format';
import { useAuth } from '@/platform/auth/AuthContext';
import {
  Ban, Camera, Check, CheckCheck, ChevronLeft, Image as ImageIcon, Paperclip,
  Search as SearchIcon, SendHorizontal, Users, X,
} from 'lucide-react';
import { DocumentChip, MessageMenu, NewChatButton, ThreadMenu, VoicePlayer, VoiceRecorder } from './MessagesExtras';
import { useToast } from '@/components/Toast';
import { useIsMobile } from '@/lib/useIsMobile';

// ── Identity chips ────────────────────────────────────────────────────────

/** Up to two initials: "Finance Team" -> FT, "Priya Nair" -> PN. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/**
 * A stable tone per conversation. The same name always lands on the same
 * swatch, so a chat keeps its colour between sessions and across devices
 * without anything being stored. Every swatch is a platform palette value.
 */
const TONES = [
  'rgb(15,34,73)', 'rgb(42,71,137)', 'rgb(38,100,231)', 'rgb(79,107,82)',
  'rgb(179,58,43)', 'rgb(166,124,38)', 'rgb(88,82,73)', 'rgb(26,48,96)',
];
function toneFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length];
}

function Avatar({
  name, size = 40, group = false, src = null,
}: { name: string; size?: number; group?: boolean; src?: string | null }) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size, boxShadow: '0 0 0 1px rgb(15 23 42 / 0.08), 0 2px 6px -2px rgb(27 58 111 / 0.45)' }}
        aria-hidden
      />
    );
  }
  return (
    <span
      className="inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0"
      style={{
        width: size, height: size,
        fontSize: Math.round(size * 0.36),
        // The brand navy gradient, as on the dashboard's activity avatars.
        background: 'linear-gradient(180deg, #2a4f8f 0%, #1b3a6f 100%)',
        boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.18), 0 2px 6px -2px rgb(27 58 111 / 0.45)',
      }}
      aria-hidden
    >
      {group ? <Users size={Math.round(size * 0.46)} strokeWidth={2} /> : initials(name)}
    </span>
  );
}

// ── Profile / group photo ─────────────────────────────────────────────────

/**
 * Turn a picked image into a small square JPEG data: URL — centre-cropped and
 * scaled to 256px — so a phone photo of several MB is stored as ~20–40 KB.
 */
function resizePhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 256;
      const ctx = canvas.getContext('2d');
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error('no canvas')); return; }
      ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not an image')); };
    img.src = url;
  });
}

/**
 * An avatar you can click to change: a camera badge sits on it, a click opens
 * a small menu (change / remove), and the picked file is resized before it is
 * saved. Used for your own photo and for a group's (admins only).
 */
function PhotoEditor({
  name, src, size, group = false, label, onSave,
}: {
  name: string; src: string | null; size: number; group?: boolean; label: string;
  onSave: (photo: string | null) => Promise<unknown>;
}) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async (photo: string | null) => {
    setBusy(true);
    try { await onSave(photo); } catch { toast.push('error', 'Could not save the photo.'); } finally { setBusy(false); }
  };
  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.push('error', 'Pick an image file.'); return; }
    try { await save(await resizePhoto(file)); } catch { toast.push('error', 'That picture could not be read.'); }
  };
  useEffect(() => {
    if (!menu) return;
    const off = () => setMenu(false);
    window.addEventListener('click', off);
    return () => window.removeEventListener('click', off);
  }, [menu]);
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        title={label}
        aria-label={label}
        disabled={busy}
        onClick={(e) => { e.stopPropagation(); if (src) setMenu((m) => !m); else fileRef.current?.click(); }}
        className={'group/photo relative inline-flex rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ' + (busy ? 'opacity-60' : '')}
      >
        <Avatar name={name} size={size} group={group} src={src} />
        <span className="absolute inset-0 rounded-full bg-black/35 opacity-0 group-hover/photo:opacity-100 transition-opacity grid place-items-center text-white" aria-hidden>
          <Camera size={Math.round(size * 0.4)} strokeWidth={2} />
        </span>
        <span
          className="absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full text-white"
          style={{ width: 18, height: 18, background: 'linear-gradient(180deg, #2a4f8f 0%, #1b3a6f 100%)', boxShadow: '0 0 0 2px #fff' }}
          aria-hidden
        >
          <Camera size={10} strokeWidth={2.25} />
        </span>
      </button>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onPick} />
      {menu ? (
        <div role="menu" className="absolute left-0 top-full mt-2 z-30 w-44 py-1 bg-white border border-neutral-200 rounded-lg shadow-raised text-13">
          <button type="button" role="menuitem" className="w-full text-left px-3 py-2 text-ink" onClick={() => { setMenu(false); fileRef.current?.click(); }}>
            Change photo
          </button>
          <button type="button" role="menuitem" className="w-full text-left px-3 py-2 text-red" onClick={() => { setMenu(false); void save(null); }}>
            Remove photo
          </button>
        </div>
      ) : null}
    </span>
  );
}

/** Your own profile photo, editable from the chat list header. */
function MyPhoto() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const me = session?.employee;
  // Seeded from the session; replaced in place when you change it.
  const photoQ = useQuery({
    queryKey: ['me', 'photo'],
    queryFn: () => me?.photo_url ?? null,
    initialData: me?.photo_url ?? null,
    staleTime: Infinity,
  });
  if (!me) return null;
  return (
    <PhotoEditor
      name={me.full_name}
      src={photoQ.data}
      size={36}
      label="Your profile photo"
      onSave={async (photo) => {
        const r = await messagesApi.setMyPhoto(photo);
        qc.setQueryData(['me', 'photo'], r.photo_url);
        // Colleagues' lists show it as your DM picture.
        void qc.invalidateQueries({ queryKey: ['chats'] });
      }}
    />
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export function MessagesPage() {
  const [params, setParams] = useSearchParams();
  const activeChatId = params.get('chat');
  const isMobile = useIsMobile();

  const chatsQ = useQuery({
    queryKey: ['chats', 'list'],
    queryFn: messagesApi.listChats,
    refetchInterval: 15_000,
  });

  const chats = chatsQ.data?.items ?? [];
  // Desktop shows both panes, so falling back to the first chat fills the
  // right-hand one. A phone shows one or the other, so the same fallback
  // would drop the user into a conversation they never chose — there the
  // list is the landing view and only an explicit ?chat= opens a thread.
  const activeChat = isMobile
    ? chats.find((c) => c.id === activeChatId) ?? null
    : chats.find((c) => c.id === activeChatId) ?? chats[0] ?? null;

  useEffect(() => {
    if (isMobile) return;
    if (!activeChatId && activeChat) setParams({ chat: activeChat.id }, { replace: true });
  }, [isMobile, activeChatId, activeChat, setParams]);

  const open = (id: string) => setParams({ chat: id }, { replace: true });

  if (isMobile) {
    return activeChat ? (
      <div className="m-thread">
        <ThreadView chat={activeChat} onBack={() => setParams({}, { replace: true })} onGone={() => setParams({}, { replace: true })} mobile />
      </div>
    ) : (
      <div className="m-page">
        <header>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.01em] text-neutral-900">Messages</h1>
        </header>
        <div className="m-card flex flex-col" data-testid="chat-sidebar" style={{ minHeight: 320 }}>
          <ChatList chats={chats} activeId={null} onPick={open} loading={chatsQ.isLoading} mobile onNew={open} />
        </div>
      </div>
    );
  }

  return (
    <div>

      {/* One bordered frame holding both panes, so the divider between them is
          the frame's own rule rather than a gap between two cards. */}
      <div
        className="dash-card grid overflow-hidden rounded-[14px]"
        style={{
          gridTemplateColumns: 'minmax(300px, 380px) 1fr',
          // One row pinned to the frame's height: a long chat list scrolls
          // inside the sidebar instead of stretching the frame and pushing the
          // composer out of view.
          gridTemplateRows: 'minmax(0, 1fr)',
          // No page heading above it: the messenger takes the whole page.
          height: 'calc(100dvh - 128px)',
          minHeight: 560,
        }}
      >
        <aside className="flex flex-col border-r border-border min-w-0 min-h-0 bg-[#fbfcfe]" data-testid="chat-sidebar">
          <ChatList chats={chats} activeId={activeChat?.id ?? null} onPick={open} loading={chatsQ.isLoading} onNew={open} />
        </aside>
        {activeChat ? (
          <ThreadView chat={activeChat} onGone={() => setParams({}, { replace: true })} />
        ) : (
          <section className="chat-wallpaper grid place-items-center p-6 text-14 text-inkMuted">
            Pick a conversation to start.
          </section>
        )}
      </div>
    </div>
  );
}

// ── Conversation list ─────────────────────────────────────────────────────

function ChatList({
  chats, activeId, onPick, loading, mobile = false, onNew,
}: {
  chats: ChatListItem[]; activeId: string | null;
  onPick: (id: string) => void; loading: boolean; mobile?: boolean; onNew: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? chats.filter((c) =>
        c.display_name.toLowerCase().includes(needle) ||
        (c.last_message?.body ?? '').toLowerCase().includes(needle))
    : chats;

  return (
    <>
      <div className="shrink-0 border-b border-border px-3 pt-3 pb-3 flex items-center gap-2">
        <MyPhoto />
        <div className="relative flex-1">
          <SearchIcon
            size={16}
            strokeWidth={1.75}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-inkFaint pointer-events-none"
            aria-hidden
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className={
              'w-full pl-9 pr-3 bg-white text-ink border border-border rounded-full shadow-card ' +
              'focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 ' +
              (mobile ? 'h-11 text-14' : 'h-9 text-13')
            }
          />
        </div>
        <NewChatButton onOpened={onNew} />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="h-24 bg-canvas" />
        ) : shown.length === 0 ? (
          <div className="p-4 text-13 text-inkMuted">
            {needle ? 'No conversations match that search.' : 'No chats yet.'}
          </div>
        ) : (
          <ul className="px-2 py-2 space-y-1">
            {shown.map((c) => (
              <li key={c.id}>
                <ChatRow
                  chat={c}
                  active={c.id === activeId}
                  onClick={() => onPick(c.id)}
                  mobile={mobile}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ChatRow({
  chat, active, onClick, mobile,
}: { chat: ChatListItem; active: boolean; onClick: () => void; mobile: boolean }) {
  const unread = chat.unread > 0;
  const preview = chat.last_message?.body
    || (chat.last_message
      ? 'Photo'
      : chat.type === 'group' ? `${chat.member_count} members` : 'Direct message');
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`chat-item-${chat.id}`}
      className={
        'w-full text-left flex items-center gap-3 px-3 rounded-lg transition-colors ' +
        (mobile ? 'py-3 min-h-[44px] ' : 'py-2 ') +
        // Selected: pale blue with a navy accent bar on the left.
        (active ? 'bg-[#e8f0fb] ' : 'hover:bg-[#f1f4f9] ')
      }
      style={active ? { boxShadow: 'inset 3px 0 0 rgb(var(--c-primary))' } : undefined}
    >
      <Avatar name={chat.display_name} size={mobile ? 44 : 46} group={chat.type === 'group'} src={chat.photo_url} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={'truncate flex-1 text-14 ' + (active ? 'text-primary ' : 'text-ink ') + (unread ? 'font-semibold' : 'font-medium')}>
            {chat.display_name}
          </span>
          {chat.last_message ? (
            <span
              className={
                'text-11 tabular-nums shrink-0 ' +
                (unread ? 'text-primary font-semibold' : 'text-inkFaint')
              }
            >
              {fmtTime(chat.last_message.created_at)}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-2 mt-px">
          <span className={'truncate flex-1 text-12 ' + (unread ? 'text-ink' : 'text-inkMuted')}>
            {preview}
          </span>
          {unread ? (
            <span className="shrink-0 inline-flex items-center justify-center h-5 min-w-[20px] px-2 rounded-full text-11 font-semibold tabular-nums text-white"
              style={{ background: 'linear-gradient(180deg, #2a4f8f 0%, #1b3a6f 100%)' }}>
              {chat.unread > 9 ? '9+' : chat.unread}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

// ── One conversation ──────────────────────────────────────────────────────

interface Row {
  type: 'day' | 'msg';
  key: string;
  label?: string;
  m?: ChatMessageWithAuthor;
  own?: boolean;
  head?: boolean;
}

function ThreadView({
  chat, onBack, onGone, mobile = false,
}: { chat: ChatListItem; onBack?: () => void; onGone: () => void; mobile?: boolean }) {
  const { session } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [replyTo, setReplyTo] = useState<ChatMessageWithAuthor | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chatId = chat.id;

  const q = useQuery({
    queryKey: ['chats', 'messages', chatId],
    queryFn: () => messagesApi.messages(chatId),
    refetchInterval: 5_000,
  });

  const messages = useMemo(() => q.data?.items ?? [], [q.data]);
  const lastMessageId = messages.length ? messages[messages.length - 1].id : null;

  const markRead = useMutation({
    mutationFn: () =>
      lastMessageId ? messagesApi.read(chatId, lastMessageId) : Promise.resolve({ marked: 0 }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats', 'list'] });
      qc.invalidateQueries({ queryKey: ['chats', 'messages', chatId] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  // Only mark read when there is something to mark. Besides saving a pointless
  // write, this is what keeps the screen quiet for a chat the caller can read
  // but is not a member of: the API lists and serves those (an MD sees the
  // firm's chats) yet answers POST /read with 403. Such a chat always reports
  // unread 0, so the guard covers it exactly.
  useEffect(() => {
    if (lastMessageId && chat.unread > 0) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, lastMessageId, chat.unread]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, chatId]);

  const send = useMutation({
    mutationFn: ({ body, images, documents }: { body: string; images: File[]; documents: File[] }) =>
      messagesApi.send(chatId, body, replyTo?.id, images, documents),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats', 'messages', chatId] });
      qc.invalidateQueries({ queryKey: ['chats', 'list'] });
      setReplyTo(null);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const ownId = session?.employee?.id ?? '';

  const sendVoice = useMutation({
    mutationFn: ({ blob, ms }: { blob: Blob; ms: number }) => messagesApi.sendVoice(chatId, blob, ms, replyTo?.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats', 'messages', chatId] });
      qc.invalidateQueries({ queryKey: ['chats', 'list'] });
      setReplyTo(null);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  // Out of a group (left or removed): history stays readable, the composer goes.
  const canWrite = chat.type === 'dm' || chat.my_role !== null;

  // Group by day, and mark the first message of each same-author run: only it
  // draws a tail and a name, so a burst from one person reads as one block.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let lastDay = '';
    let lastAuthor = '';
    for (const m of messages) {
      const day = new Date(m.created_at).toDateString();
      if (day !== lastDay) {
        out.push({ type: 'day', key: `d-${day}`, label: dayLabel(m.created_at) });
        lastDay = day;
        lastAuthor = '';
      }
      const author = m.author?.id ?? '—';
      out.push({ type: 'msg', key: m.id, m, own: author === ownId, head: author !== lastAuthor });
      lastAuthor = author;
    }
    return out;
  }, [messages, ownId]);

  return (
    <section className="flex flex-col min-w-0 min-h-0 h-full" data-testid="conversation">
      <div
        className={
          'flex items-center gap-3 shrink-0 border-b border-border bg-white ' +
          (mobile ? 'pb-2' : 'px-5 py-3')
        }
      >
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="inline-flex items-center justify-center w-11 h-11 -ml-2 rounded text-inkMuted hover:text-ink"
          >
            <ChevronLeft size={22} strokeWidth={1.75} />
          </button>
        ) : null}
        {chat.type === 'group' && chat.my_role === 'admin' ? (
          <PhotoEditor
            name={chat.display_name}
            src={chat.photo_url}
            size={mobile ? 36 : 42}
            group
            label="Group photo"
            onSave={async (photo) => {
              await messagesApi.updateGroup(chat.id, { photo_url: photo });
              void qc.invalidateQueries({ queryKey: ['chats'] });
            }}
          />
        ) : (
          <Avatar name={chat.display_name} size={mobile ? 36 : 42} group={chat.type === 'group'} src={chat.photo_url} />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-16 font-semibold text-ink truncate">{chat.display_name}</div>
          <div className="text-12 text-inkMuted truncate flex items-center gap-2">
            <span className="rounded-full" style={{ background: '#10b981', width: 6, height: 6 }} aria-hidden />
            {chat.type === 'group' ? `${chat.member_count} members` : 'Direct message'}
          </div>
        </div>
        <ThreadMenu chat={chat} onGone={onGone} />
      </div>

      <div className="chat-scroll chat-wallpaper px-4 py-4" ref={scrollRef}>
        {q.isLoading ? (
          <div className="h-24 bg-canvas rounded" />
        ) : messages.length === 0 ? (
          <div className="grid place-items-center h-full text-13 text-inkMuted">No messages yet.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {rows.map((row) =>
              row.type === 'day' ? (
                <div key={row.key} className="flex justify-center my-2">
                  <span className="chat-daymark">{row.label}</span>
                </div>
              ) : (
                <Bubble
                  key={row.key}
                  chat={chat}
                  message={row.m!}
                  own={!!row.own}
                  head={!!row.head}
                  group={chat.type === 'group'}
                  onReply={() => setReplyTo(row.m!)}
                />
              ),
            )}
          </div>
        )}
      </div>

      {canWrite ? (
        <Composer
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          onSend={(text, images, documents) => send.mutate({ body: text, images, documents })}
          onVoice={(blob, ms) => sendVoice.mutate({ blob, ms })}
          onReject={(reason) => toast.push('error', reason)}
          busy={send.isPending || sendVoice.isPending}
          sent={send.isSuccess}
          mobile={mobile}
        />
      ) : (
        <div className="shrink-0 border-t border-border bg-surface p-3 text-center text-13 text-inkMuted">
          You can’t send messages to this group because you’re no longer a member.
        </div>
      )}
    </section>
  );
}

/** "Today" / "Yesterday" / a plain date, the way a messenger marks a day. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function Bubble({
  chat, message, own, head, group, onReply,
}: {
  chat: ChatListItem; message: ChatMessageWithAuthor; own: boolean; head: boolean;
  group: boolean; onReply: () => void;
}) {
  const images = message.attachments.filter((a) => (a.kind ?? 'image') === 'image');
  const voice = message.attachments.filter((a) => a.kind === 'audio');
  const docs = message.attachments.filter((a) => a.kind === 'document');
  const hasImages = images.length > 0 || docs.length > 0 || voice.length > 0;
  return (
    <div
      className={'flex w-full ' + (own ? 'justify-end' : 'justify-start') + (head ? ' mt-2' : '')}
      data-testid={`msg-${message.id}`}
    >
      <div
        className={
          'chat-bubble group/bubble px-3 py-2 ' +
          (own ? 'chat-bubble--own ' : 'chat-bubble--them ') +
          (head ? 'chat-bubble--tail ' : '')
        }
      >
        {/* In a group, who is speaking matters; in a DM it is noise. */}
        {!own && group && head ? (
          <div className="text-12 font-semibold mb-0.5" style={{ color: toneFor(message.author?.full_name ?? '—') }}>
            {message.author?.full_name ?? '—'}
          </div>
        ) : null}

        {message.parent_preview ? (
          <div className={'mb-1 rounded-md border-l-2 px-2 py-1 ' + (own ? 'border-white/70 bg-white/15' : 'border-primary bg-[#f1f4f9]')}>
            <div className={'text-11 font-medium truncate ' + (own ? 'text-white' : 'text-ink')}>
              {message.parent_preview.author_full_name ?? '—'}
            </div>
            <div className={'text-11 truncate ' + (own ? 'text-white/75' : 'text-inkMuted')}>{message.parent_preview.body}</div>
          </div>
        ) : null}

        {message.deleted ? (
          <div className={'flex items-center gap-2 text-13 italic py-0.5 ' + (own ? 'text-white/75' : 'text-inkMuted')}>
            <Ban size={14} aria-hidden /> {own ? 'You deleted this message' : 'This message was deleted'}
          </div>
        ) : null}

        {images.length ? <AttachmentGrid attachments={images} /> : null}
        {voice.map((a) => <VoicePlayer key={a.id} attachment={a} own={own} />)}
        {docs.length ? <div className={'flex flex-col gap-1 ' + (images.length ? 'mt-1' : '')}>{docs.map((a) => <DocumentChip key={a.id} attachment={a} />)}</div> : null}

        {/* An attachment-only message has no caption — don't leave an empty line. */}
        {message.body ? (
          <div className={'text-13 whitespace-pre-wrap break-words ' + (own ? 'text-white ' : 'text-ink ') + (hasImages ? 'mt-2' : '')}>
            {message.body}
          </div>
        ) : null}

        {/* Time and receipt ride the bottom-right of the bubble. Reply is
            revealed on hover where there is a pointer, and stays put on touch
            where there is not. */}
        <div className="flex items-center gap-1 mt-0.5 -mb-0.5">
          <span className="mr-auto pr-2 flex items-center gap-1">
            {!message.deleted && (chat.type === 'dm' || chat.my_role !== null) ? (
              <button
                type="button"
                onClick={onReply}
                data-testid={`msg-reply-${message.id}`}
                className={'text-11 md:opacity-0 md:group-hover/bubble:opacity-100 md:transition-opacity ' + (own ? 'text-white/70 hover:text-white' : 'text-inkFaint hover:text-primary')}
              >
                Reply
              </button>
            ) : null}
            <MessageMenu chat={chat} message={message} own={own} onReply={onReply} />
          </span>
          <span className={'text-11 tabular-nums ' + (own ? 'text-white/70' : 'text-inkFaint')}>{fmtTime(message.created_at)}</span>
          {own ? (
            message.read_by_me ? (
              <CheckCheck size={13} strokeWidth={2.25} className="text-[#7dd3fc]" aria-label="Read" />
            ) : (
              <Check size={13} strokeWidth={2.25} className="text-white/60" aria-label="Sent" />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Images in a message. One fills the bubble; several tile, so a burst of
 * screenshots stays one readable unit rather than a tall column.
 */
function AttachmentGrid({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <div className={'grid gap-1 ' + (attachments.length === 1 ? 'grid-cols-1' : 'grid-cols-2')}>
      {attachments.map((a) => (
        <a
          key={a.id}
          href={a.url}
          target="_blank"
          rel="noreferrer"
          title={`${a.filename} · ${fmtFileSize(a.file_size)}`}
          className="block overflow-hidden rounded border border-border bg-canvas"
          data-testid={`attachment-${a.id}`}
        >
          <img
            src={a.url}
            alt={a.filename}
            loading="lazy"
            className="block w-full max-h-[260px] object-cover"
          />
        </a>
      ))}
    </div>
  );
}

function fmtFileSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Composer ──────────────────────────────────────────────────────────────

/** Mirrors the server's accepted list — SVG is deliberately excluded. */
const ACCEPTED_IMAGES = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_IMAGES = 6;
const MAX_IMAGE_MB = 10;

const ACCEPTED_DOCUMENTS = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip';
const MAX_DOCUMENTS = 5;
const MAX_DOCUMENT_MB = 25;

function Composer({
  replyTo, onClearReply, onSend, onVoice, onReject, busy, sent, mobile,
}: {
  replyTo: ChatMessageWithAuthor | null; onClearReply: () => void;
  onSend: (body: string, images: File[], documents: File[]) => void; onVoice: (blob: Blob, ms: number) => void;
  onReject: (reason: string) => void;
  busy: boolean; sent: boolean; mobile: boolean;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const [documents, setDocuments] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const docRef = useRef<HTMLInputElement | null>(null);
  const pickDocs = (e: ChangeEvent<HTMLInputElement>) => {
    const incoming = Array.from(e.target.files ?? []);
    e.target.value = '';
    const ok = incoming.filter((f) => {
      const ext = (f.name.split('.').pop() ?? '').toLowerCase();
      if (!ACCEPTED_DOCUMENTS.split(',').includes(`.${ext}`)) { onReject(`"${f.name}" is not a PDF, Word, Excel, PowerPoint, CSV, text or zip file.`); return false; }
      if (f.size > MAX_DOCUMENT_MB * 1024 * 1024) { onReject(`"${f.name}" is larger than ${MAX_DOCUMENT_MB} MB.`); return false; }
      return true;
    });
    setDocuments((prev) => {
      const room = MAX_DOCUMENTS - prev.length;
      if (ok.length > room) onReject(`A message carries at most ${MAX_DOCUMENTS} documents.`);
      return [...prev, ...ok.slice(0, Math.max(0, room))];
    });
  };

  // Object URLs are revoked on change, so a long session does not leak a blob
  // per preview. The effect owns the whole list rather than one entry.
  const [previews, setPreviews] = useState<string[]>([]);
  useEffect(() => {
    const urls = images.map((f) => URL.createObjectURL(f));
    setPreviews(urls);
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [images]);

  // Clear the tray only once the send actually succeeded — a failed upload
  // must not silently discard the images the user picked.
  useEffect(() => {
    if (sent) { setText(''); setImages([]); setDocuments([]); }
  }, [sent]);

  /** Shared by the file picker and paste: same limits, same messages. */
  const accept = (incoming: File[]) => {
    const picked = incoming.filter((f) => {
      if (!ACCEPTED_IMAGES.includes(f.type)) {
        onReject(`"${f.name}" is not a PNG, JPEG, WebP or GIF image.`);
        return false;
      }
      if (f.size > MAX_IMAGE_MB * 1024 * 1024) {
        onReject(`"${f.name}" is larger than ${MAX_IMAGE_MB} MB.`);
        return false;
      }
      return true;
    });
    if (picked.length === 0) return;
    setImages((prev) => {
      const room = MAX_IMAGES - prev.length;
      if (room <= 0) {
        onReject(`A message carries at most ${MAX_IMAGES} images.`);
        return prev;
      }
      if (picked.length > room) onReject(`Only ${room} more image${room === 1 ? '' : 's'} fit on this message.`);
      return [...prev, ...picked.slice(0, room)];
    });
  };

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    accept(Array.from(e.target.files ?? []));
    // Reset so picking the same file twice in a row still fires a change.
    e.target.value = '';
  };

  // Pasting a screenshot straight into the composer is how people actually
  // send one, so the clipboard is a first-class input here.
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0) return;
    e.preventDefault();
    accept(files);
  };

  const canSend = !busy && (text.trim().length > 0 || images.length > 0 || documents.length > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    onSend(text.trim(), images, documents);
  };

  return (
    <form
      onSubmit={submit}
      className={'shrink-0 border-t border-border bg-white ' + (mobile ? 'pt-2 pb-1' : 'px-4 py-3')}
    >
      {replyTo ? (
        <div className="flex items-start justify-between gap-2 mb-2 rounded-lg border-l-2 border-primary bg-[#e8f0fb] px-3 py-2">
          <div className="min-w-0">
            <div className="text-11 font-medium text-primary">
              Replying to {replyTo.author?.full_name ?? '—'}
            </div>
            <div className="text-11 text-inkMuted truncate">{replyTo.body.slice(0, 120)}</div>
          </div>
          <button
            type="button"
            onClick={onClearReply}
            aria-label="Cancel reply"
            className="shrink-0 text-inkMuted hover:text-ink"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
      ) : null}

      {images.length > 0 ? (
        <ul className="flex flex-wrap gap-2 mb-2" data-testid="composer-tray">
          {images.map((f, i) => (
            <li key={`${f.name}-${i}`} className="relative">
              <img
                src={previews[i]}
                alt={f.name}
                className="h-16 w-16 object-cover rounded border border-border"
              />
              <button
                type="button"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                aria-label={`Remove ${f.name}`}
                className="absolute -top-1.5 -right-1.5 h-5 w-5 text-11 leading-none bg-ink text-white rounded-full"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {documents.length > 0 ? (
        <ul className="flex flex-wrap gap-2 mb-2" data-testid="composer-docs">
          {documents.map((f, i) => (
            <li key={`${f.name}-${i}`} className="inline-flex items-center gap-2 max-w-[260px] rounded border border-border bg-canvas pl-2 pr-1 py-1 text-12">
              <Paperclip size={13} className="shrink-0 text-inkMuted" />
              <span className="truncate" title={f.name}>{f.name}</span>
              <button type="button" onClick={() => setDocuments((prev) => prev.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`} className="shrink-0 text-inkMuted hover:text-ink"><X size={13} /></button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-1 p-1 rounded-full bg-[#f4f6fa] border border-border focus-within:border-primary/50 focus-within:bg-white focus-within:shadow-card transition-colors">
        <input ref={docRef} type="file" accept={ACCEPTED_DOCUMENTS} multiple onChange={pickDocs} className="hidden" data-testid="composer-doc-file" />
        <button
          type="button"
          onClick={() => docRef.current?.click()}
          disabled={documents.length >= MAX_DOCUMENTS}
          title="Attach a document (PDF, Word, Excel, PowerPoint, CSV, text, zip)"
          aria-label="Attach a document"
          className="inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-full text-inkMuted hover:text-ink hover:bg-canvas disabled:opacity-50"
          data-testid="composer-attach-doc"
        >
          <Paperclip size={17} strokeWidth={1.75} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_IMAGES}
          multiple
          onChange={onPick}
          className="hidden"
          data-testid="composer-file"
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={images.length >= MAX_IMAGES}
          title={images.length >= MAX_IMAGES ? `At most ${MAX_IMAGES} images per message` : 'Attach an image'}
          aria-label="Attach an image"
          className="inline-flex items-center justify-center w-8 h-8 shrink-0 rounded-full text-inkMuted hover:text-ink hover:bg-canvas disabled:opacity-50"
          data-testid="composer-attach"
        >
          <ImageIcon size={17} strokeWidth={1.75} />
        </button>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          placeholder={images.length > 0 ? 'Add a caption…' : 'Type a message'}
          className={
            'flex-1 min-w-0 px-3 bg-transparent text-ink border-0 ' +
            'focus:outline-none ' +
            (mobile ? 'h-11 text-14' : 'h-9 text-13')
          }
          data-testid="composer-input"
        />
        {/* Nothing typed or attached: the mic records a voice message instead. */}
        {canSend || busy ? (
          <button
            type="submit"
            disabled={!canSend}
            className="chat-send"
            aria-label="Send message"
            data-testid="composer-send"
          >
            <SendHorizontal size={16} strokeWidth={2} />
          </button>
        ) : (
          <VoiceRecorder onSend={onVoice} disabled={busy} />
        )}
      </div>
    </form>
  );
}
