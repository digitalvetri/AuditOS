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
 *   Skipped: reactions, @mentions, in-conversation search.
 *   Included: text, image attachments, reply-to, read receipts, unread counts,
 *             DM creation.
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
  Check, CheckCheck, ChevronLeft, Image as ImageIcon,
  Search as SearchIcon, SendHorizontal, Users, X,
} from 'lucide-react';
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
  name, size = 40, group = false,
}: { name: string; size?: number; group?: boolean }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full text-white font-semibold shrink-0"
      style={{
        width: size, height: size,
        fontSize: Math.round(size * 0.36),
        backgroundColor: toneFor(name),
      }}
      aria-hidden
    >
      {group ? <Users size={Math.round(size * 0.46)} strokeWidth={2} /> : initials(name)}
    </span>
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
        <ThreadView chat={activeChat} onBack={() => setParams({}, { replace: true })} mobile />
      </div>
    ) : (
      <div className="m-page">
        <header>
          <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
          <h1 className="text-20 font-semibold text-neutral-900 mt-1">Messages</h1>
        </header>
        <div className="m-card flex flex-col" data-testid="chat-sidebar" style={{ minHeight: 320 }}>
          <ChatList chats={chats} activeId={null} onPick={open} loading={chatsQ.isLoading} mobile />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Messages</h1>
      </header>

      {/* One bordered frame holding both panes, so the divider between them is
          the frame's own rule rather than a gap between two cards. */}
      <div
        className="grid bg-surface border border-border rounded overflow-hidden"
        style={{
          gridTemplateColumns: 'minmax(260px, 340px) 1fr',
          height: 'calc(100dvh - 220px)',
          minHeight: 520,
        }}
      >
        <aside className="flex flex-col border-r border-border min-w-0" data-testid="chat-sidebar">
          <ChatList chats={chats} activeId={activeChat?.id ?? null} onPick={open} loading={chatsQ.isLoading} />
        </aside>
        {activeChat ? (
          <ThreadView chat={activeChat} />
        ) : (
          <section className="chat-wallpaper grid place-items-center p-6 text-13 text-inkMuted">
            Pick a conversation to start.
          </section>
        )}
      </div>
    </div>
  );
}

// ── Conversation list ─────────────────────────────────────────────────────

function ChatList({
  chats, activeId, onPick, loading, mobile = false,
}: {
  chats: ChatListItem[]; activeId: string | null;
  onPick: (id: string) => void; loading: boolean; mobile?: boolean;
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
      <div className="shrink-0 border-b border-border p-3">
        <div className="relative">
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
              'w-full pl-9 pr-3 bg-canvas text-ink border border-border rounded-full ' +
              'focus:outline-none focus:border-primary ' +
              (mobile ? 'h-11 text-14' : 'h-9 text-13')
            }
          />
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="h-24 bg-canvas" />
        ) : shown.length === 0 ? (
          <div className="p-4 text-13 text-inkMuted">
            {needle ? 'No conversations match that search.' : 'No chats yet.'}
          </div>
        ) : (
          <ul>
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
        'w-full text-left flex items-center gap-3 px-3 border-b border-border transition-colors ' +
        (mobile ? 'py-3 min-h-[44px] ' : 'py-2.5 ') +
        (active ? 'bg-canvas ' : 'hover:bg-canvas ')
      }
    >
      <Avatar name={chat.display_name} size={mobile ? 44 : 40} group={chat.type === 'group'} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={'truncate flex-1 text-14 text-ink ' + (unread ? 'font-semibold' : 'font-medium')}>
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
        <span className="flex items-center gap-2 mt-0.5">
          <span className={'truncate flex-1 text-12 ' + (unread ? 'text-ink' : 'text-inkMuted')}>
            {preview}
          </span>
          {unread ? (
            <span className="shrink-0 text-11 tabular-nums text-white bg-primary rounded-full px-1.5 min-w-[20px] text-center">
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
  chat, onBack, mobile = false,
}: { chat: ChatListItem; onBack?: () => void; mobile?: boolean }) {
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
    mutationFn: ({ body, images }: { body: string; images: File[] }) =>
      messagesApi.send(chatId, body, replyTo?.id, images),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats', 'messages', chatId] });
      qc.invalidateQueries({ queryKey: ['chats', 'list'] });
      setReplyTo(null);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  const ownId = session?.employee?.id ?? '';

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
          'flex items-center gap-3 shrink-0 border-b border-border bg-surface ' +
          (mobile ? 'pb-2' : 'px-4 py-2.5')
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
        <Avatar name={chat.display_name} size={mobile ? 36 : 38} group={chat.type === 'group'} />
        <div className="min-w-0 flex-1">
          <div className="text-14 font-semibold text-ink truncate">{chat.display_name}</div>
          <div className="text-11 text-inkMuted truncate">
            {chat.type === 'group' ? `${chat.member_count} members` : 'Direct message'}
          </div>
        </div>
      </div>

      <div className="chat-scroll chat-wallpaper px-3 py-3" ref={scrollRef}>
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

      <Composer
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onSend={(text, images) => send.mutate({ body: text, images })}
        onReject={(reason) => toast.push('error', reason)}
        busy={send.isPending}
        sent={send.isSuccess}
        mobile={mobile}
      />
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
  message, own, head, group, onReply,
}: {
  message: ChatMessageWithAuthor; own: boolean; head: boolean;
  group: boolean; onReply: () => void;
}) {
  const hasImages = message.attachments.length > 0;
  return (
    <div
      className={'flex w-full ' + (own ? 'justify-end' : 'justify-start') + (head ? ' mt-2' : '')}
      data-testid={`msg-${message.id}`}
    >
      <div
        className={
          'chat-bubble group/bubble px-2.5 py-1.5 ' +
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
          <div className="mb-1 rounded border-l-2 border-primary bg-canvas px-2 py-1">
            <div className="text-11 font-medium text-ink truncate">
              {message.parent_preview.author_full_name ?? '—'}
            </div>
            <div className="text-11 text-inkMuted truncate">{message.parent_preview.body}</div>
          </div>
        ) : null}

        {hasImages ? <AttachmentGrid attachments={message.attachments} /> : null}

        {/* An image-only message has no caption — don't leave an empty line. */}
        {message.body ? (
          <div className={'text-13 text-ink whitespace-pre-wrap break-words ' + (hasImages ? 'mt-1.5' : '')}>
            {message.body}
          </div>
        ) : null}

        {/* Time and receipt ride the bottom-right of the bubble. Reply is
            revealed on hover where there is a pointer, and stays put on touch
            where there is not. */}
        <div className="flex items-center gap-1 mt-0.5 -mb-0.5">
          <button
            type="button"
            onClick={onReply}
            data-testid={`msg-reply-${message.id}`}
            className={
              'text-11 text-inkFaint hover:text-primary mr-auto pr-3 ' +
              'md:opacity-0 md:group-hover/bubble:opacity-100 md:transition-opacity'
            }
          >
            Reply
          </button>
          <span className="text-11 tabular-nums text-inkFaint">{fmtTime(message.created_at)}</span>
          {own ? (
            message.read_by_me ? (
              <CheckCheck size={13} strokeWidth={2.25} className="text-primary" aria-label="Read" />
            ) : (
              <Check size={13} strokeWidth={2.25} className="text-inkFaint" aria-label="Sent" />
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

function Composer({
  replyTo, onClearReply, onSend, onReject, busy, sent, mobile,
}: {
  replyTo: ChatMessageWithAuthor | null; onClearReply: () => void;
  onSend: (body: string, images: File[]) => void; onReject: (reason: string) => void;
  busy: boolean; sent: boolean; mobile: boolean;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<File[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);

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
    if (sent) { setText(''); setImages([]); }
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

  const canSend = !busy && (text.trim().length > 0 || images.length > 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    onSend(text.trim(), images);
  };

  return (
    <form
      onSubmit={submit}
      className={'shrink-0 border-t border-border bg-surface ' + (mobile ? 'pt-2 pb-1' : 'p-3')}
    >
      {replyTo ? (
        <div className="flex items-start justify-between gap-2 mb-2 rounded border-l-2 border-primary bg-canvas px-2 py-1.5">
          <div className="min-w-0">
            <div className="text-11 font-medium text-ink">
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

      <div className="flex items-center gap-2">
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
          className="inline-flex items-center justify-center w-10 h-10 shrink-0 rounded-full text-inkMuted hover:text-ink hover:bg-canvas disabled:opacity-50"
          data-testid="composer-attach"
        >
          <ImageIcon size={20} strokeWidth={1.75} />
        </button>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={onPaste}
          placeholder={images.length > 0 ? 'Add a caption…' : 'Type a message'}
          className={
            'flex-1 min-w-0 px-4 bg-canvas text-ink border border-border rounded-full ' +
            'focus:outline-none focus:border-primary ' +
            (mobile ? 'h-11 text-14' : 'h-10 text-14')
          }
          data-testid="composer-input"
        />
        <button
          type="submit"
          disabled={!canSend}
          className="chat-send"
          aria-label="Send message"
          data-testid="composer-send"
        >
          <SendHorizontal size={18} strokeWidth={2} />
        </button>
      </div>
    </form>
  );
}
