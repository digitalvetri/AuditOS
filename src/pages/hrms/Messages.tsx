/**
 * /hrms/messages — two-pane messaging per §8.7.
 *
 * Scope cuts for this scaffold (documented in module handoff):
 *   Skipped: attachments, reactions, @mentions, in-conversation search.
 *   Included: text, reply-to, read receipts, unread counts, DM creation.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { messagesApi, type ChatListItem, type ChatMessageWithAuthor } from '@/modules/messages/api';
import { fmtDateTime, fmtTime } from '@/lib/format';
import { useAuth } from '@/platform/auth/AuthContext';
import { Button } from '@/components/Button';
import { useToast } from '@/components/Toast';

export function MessagesPage() {
  const [params, setParams] = useSearchParams();
  const activeChatId = params.get('chat');

  const chatsQ = useQuery({
    queryKey: ['chats', 'list'],
    queryFn: messagesApi.listChats,
    refetchInterval: 15_000,
  });

  const chats = chatsQ.data?.items ?? [];
  const activeChat = chats.find((c) => c.id === activeChatId) ?? chats[0] ?? null;

  useEffect(() => {
    // If no ?chat= and we have chats, deep-link to the first for shareability.
    if (!activeChatId && activeChat) setParams({ chat: activeChat.id }, { replace: true });
  }, [activeChatId, activeChat, setParams]);

  return (
    <div className="max-w-[1200px] mx-auto space-y-4">
      <header>
        <div className="text-11 uppercase tracking-[0.06em] text-neutral-500">HRMS</div>
        <h1 className="text-20 font-semibold text-neutral-900 mt-1">Messages</h1>
      </header>

      <div
        className="grid gap-4"
        style={{ gridTemplateColumns: '280px 1fr', minHeight: '520px' }}
      >
        <ChatSidebar
          chats={chats}
          activeId={activeChat?.id ?? null}
          onPick={(id) => setParams({ chat: id }, { replace: true })}
          loading={chatsQ.isLoading}
        />
        <ConversationPane chatId={activeChat?.id ?? null} />
      </div>
    </div>
  );
}

// ── Sidebar ──────────────────────────────────────────────────────────────
function ChatSidebar({
  chats, activeId, onPick, loading,
}: { chats: ChatListItem[]; activeId: string | null; onPick: (id: string) => void; loading: boolean }) {
  return (
    <aside className="bg-white border border-neutral-200 rounded overflow-hidden flex flex-col" data-testid="chat-sidebar">
      <div className="h-10 px-3 flex items-center border-b border-neutral-200 text-11 uppercase tracking-[0.06em] text-neutral-500">
        Conversations
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="h-24 bg-neutral-100" />
        ) : chats.length === 0 ? (
          <div className="p-4 text-13 text-neutral-500">No chats yet.</div>
        ) : (
          <ul>
            {chats.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onPick(c.id)}
                    data-testid={`chat-item-${c.id}`}
                    className={
                      'w-full text-left px-3 py-2 border-b border-neutral-200 border-l-2 ' +
                      (active
                        ? 'border-l-gold bg-neutral-50'
                        : c.unread > 0
                          ? 'border-l-amber hover:bg-neutral-50'
                          : 'border-l-transparent hover:bg-neutral-50')
                    }
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className={'text-13 truncate ' + (c.unread > 0 ? 'text-neutral-900 font-medium' : 'text-neutral-900')}>
                        {c.display_name}
                      </div>
                      {c.unread > 0 ? (
                        <span className="text-11 tabular-nums text-white bg-gold rounded px-1 min-w-[16px] text-center">
                          {c.unread > 9 ? '9+' : c.unread}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-11 text-neutral-500 truncate mt-0.5">
                      {c.type === 'group' ? `${c.member_count} members` : 'Direct message'}
                      {c.last_message ? ` · ${c.last_message.body.slice(0, 40)}` : ''}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

// ── Conversation pane ────────────────────────────────────────────────────
function ConversationPane({ chatId }: { chatId: string | null }) {
  const { session } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [replyTo, setReplyTo] = useState<ChatMessageWithAuthor | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const q = useQuery({
    queryKey: ['chats', 'messages', chatId],
    queryFn: () => (chatId ? messagesApi.messages(chatId) : Promise.resolve(null as never)),
    enabled: !!chatId,
    refetchInterval: 5_000,
  });

  const messages = q.data?.items ?? [];
  const lastMessageId = useMemo(() => (messages.length ? messages[messages.length - 1].id : null), [messages]);

  // Mark all read whenever the view mounts / the newest message id changes.
  const markRead = useMutation({
    mutationFn: () => (chatId && lastMessageId ? messagesApi.read(chatId, lastMessageId) : Promise.resolve({ marked: 0 })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats', 'list'] });
      qc.invalidateQueries({ queryKey: ['chats', 'messages', chatId] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });
  useEffect(() => {
    if (chatId && lastMessageId) markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, lastMessageId]);

  // Auto-scroll to bottom when messages change.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, chatId]);

  const send = useMutation({
    mutationFn: (body: string) =>
      chatId ? messagesApi.send(chatId, body, replyTo?.id) : Promise.reject(new Error('No chat')),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['chats', 'messages', chatId] });
      qc.invalidateQueries({ queryKey: ['chats', 'list'] });
      setReplyTo(null);
    },
    onError: (e: Error) => toast.push('error', e.message),
  });

  if (!chatId) {
    return (
      <section className="bg-white border border-neutral-200 rounded p-6 text-13 text-neutral-500">
        Pick a conversation to start.
      </section>
    );
  }

  return (
    <section className="bg-white border border-neutral-200 rounded flex flex-col" data-testid="conversation">
      <div className="h-10 px-3 flex items-center border-b border-neutral-200 text-13 text-neutral-900 font-medium">
        {q.data?.chat.display_name ?? '…'}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2" ref={scrollRef}>
        {q.isLoading ? (
          <div className="h-24 bg-neutral-100" />
        ) : messages.length === 0 ? (
          <div className="text-13 text-neutral-500">No messages yet.</div>
        ) : (
          messages.map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              ownEmployeeId={session?.employee?.id ?? ''}
              onReply={() => setReplyTo(m)}
            />
          ))
        )}
      </div>
      <Composer
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        onSend={(text) => send.mutate(text)}
        busy={send.isPending}
      />
    </section>
  );
}

function MessageRow({
  message, ownEmployeeId, onReply,
}: { message: ChatMessageWithAuthor; ownEmployeeId: string; onReply: () => void }) {
  const own = message.author?.id === ownEmployeeId;
  return (
    <div
      className={'flex ' + (own ? 'justify-end' : 'justify-start')}
      data-testid={`msg-${message.id}`}
    >
      <div className={'max-w-[70%] ' + (own ? 'items-end' : 'items-start')}>
        {message.parent_preview ? (
          <div className={'text-11 text-neutral-500 border-l-2 border-neutral-300 pl-2 mb-1 ' + (own ? 'text-right pr-2 border-l-0 border-r-2 pl-0' : '')}>
            ↳ {message.parent_preview.author_full_name ?? '—'}: {message.parent_preview.body}
          </div>
        ) : null}
        <div className={'text-11 text-neutral-500 tabular-nums ' + (own ? 'text-right' : '')}>
          {own ? 'You' : message.author?.full_name ?? '—'} · {fmtTime(message.created_at)}
        </div>
        <div
          className={
            'mt-1 px-3 py-2 text-13 rounded border ' +
            (own ? 'bg-neutral-50 border-neutral-200 text-neutral-900' : 'bg-white border-neutral-200 text-neutral-900')
          }
        >
          {message.body}
        </div>
        <div className="mt-1">
          <button
            type="button"
            onClick={onReply}
            className={'text-11 text-neutral-500 hover:text-gold ' + (own ? 'float-right' : '')}
            data-testid={`msg-reply-${message.id}`}
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  );
}

function Composer({
  replyTo, onClearReply, onSend, busy,
}: { replyTo: ChatMessageWithAuthor | null; onClearReply: () => void; onSend: (body: string) => void; busy: boolean }) {
  const [text, setText] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
  };
  return (
    <form onSubmit={submit} className="border-t border-neutral-200 p-3 space-y-2">
      {replyTo ? (
        <div className="flex items-start justify-between gap-2 text-11 text-neutral-500 border-l-2 border-amber pl-2">
          <div>Replying to {replyTo.author?.full_name ?? '—'}: {replyTo.body.slice(0, 100)}</div>
          <button type="button" onClick={onClearReply} className="text-neutral-500 hover:text-neutral-900">Clear</button>
        </div>
      ) : null}
      <div className="flex gap-2">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 h-9 px-3 text-13 bg-white border border-neutral-300 rounded focus:outline-none focus:border-gold"
          data-testid="composer-input"
        />
        <Button variant="primary" type="submit" disabled={busy || !text.trim()} data-testid="composer-send">
          Send
        </Button>
      </div>
      <p className="text-11 text-neutral-500">
        {fmtDateTime(new Date().toISOString()).replace(fmtTime(new Date().toISOString()), '')}
        Scaffold: attachments, reactions, mentions and search are not built in this session.
      </p>
    </form>
  );
}
