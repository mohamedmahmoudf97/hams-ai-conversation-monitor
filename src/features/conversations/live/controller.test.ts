import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConversations, getMessages } from '../../../api/client';
import type { ConversationsResponse, Message, MessagesResponse } from '../../../domain/conversation';
import { connectEvents } from './connection';
import { createConversationLive } from './controller';
import type { LiveEvent } from './events';

vi.mock('../../../api/client');
vi.mock('./connection');

const timestamp = '2026-11-23T12:00:00.000Z';
const message = (id: string, conversationId = 'c-1', text = 'Hello'): Message => ({
  id,
  conversationId,
  role: 'customer',
  text,
  createdAt: timestamp,
});
const inbox = (lastEventId = 10): ConversationsResponse => ({
  lastEventId,
  conversations: ['c-1', 'c-2'].map((id) => ({
    id,
    customer: id,
    status: 'ai',
    lastMessage: 'Previous',
    unread: 0,
    updatedAt: timestamp,
  })),
});
const start = (id: number, conversationId = 'c-1'): LiveEvent => ({
  id,
  conversationId,
  type: 'message_start',
  messageId: 'ai-1',
  role: 'ai',
});
const token = (id: number, text: string, conversationId = 'c-1'): LiveEvent => ({
  id,
  conversationId,
  type: 'token',
  messageId: 'ai-1',
  text,
});
const end = (id: number, conversationId = 'c-1'): LiveEvent => ({
  id,
  conversationId,
  type: 'message_end',
  messageId: 'ai-1',
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

let client: QueryClient;
let live: ReturnType<typeof createConversationLive>;
let connection: Parameters<typeof connectEvents>[0];
let close = vi.fn<() => void>();
const emit = (event: LiveEvent) => connection.onEvent(event);
const loadInbox = () =>
  client.fetchQuery({
    queryKey: ['conversations'],
    queryFn: ({ signal }) => live.loadConversations(signal),
    staleTime: 0,
  });
const loadThread = (id = 'c-1') =>
  client.fetchQuery({
    queryKey: ['messages', id],
    queryFn: ({ signal }) => live.loadMessages(id, signal),
    staleTime: 0,
  });
const cachedThread = (id = 'c-1') => client.getQueryData<MessagesResponse>(['messages', id]);
const cachedInbox = () => client.getQueryData<ConversationsResponse>(['conversations'])!;

beforeEach(async () => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  close = vi.fn();
  vi.mocked(connectEvents).mockImplementation((options) => {
    connection = options;
    return close;
  });
  vi.mocked(getConversations).mockResolvedValue(inbox());
  vi.mocked(getMessages).mockResolvedValue({ lastEventId: 10, messages: [] });
  live = createConversationLive(client);
  live.start();
  await loadInbox();
});

afterEach(() => {
  live.stop();
  client.clear();
  vi.useRealTimers();
});

describe('live conversation reconciliation', () => {
  it('deduplicates replayed messages and tokens and commits completed text once', async () => {
    await loadThread();
    const customer: LiveEvent = { id: 11, type: 'message', conversationId: 'c-1', message: message('m-1') };
    emit(customer);
    emit(customer);
    emit(start(12));
    emit(token(13, 'Hello '));
    emit(token(13, 'Hello '));
    emit(token(14, 'world'));
    emit(end(15));
    emit(end(15));
    expect(cachedThread()?.messages.map(({ text }) => text)).toEqual(['Hello', 'Hello world']);
    expect(cachedInbox().conversations[0]).toMatchObject({ unread: 1, lastMessage: 'Hello world' });
    expect(live.store.getState().streams).toEqual({});
    expect(connection.getCursor()).toBe(15);
  });

  it('orders inbox activity by event sequence when the client clock is behind the server', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T11:59:50.000Z'));
    await loadThread();
    emit({ id: 11, type: 'message', conversationId: 'c-2', message: message('customer-2', 'c-2') });
    expect(cachedInbox().conversations[0]?.id).toBe('c-2');
    emit(start(12));
    emit(token(13, 'Newest activity'));
    emit(end(14));
    expect(cachedInbox().conversations[0]).toMatchObject({ id: 'c-1', lastMessage: 'Newest activity' });
    emit({ id: 15, type: 'message', conversationId: 'c-2', message: message('customer-3', 'c-2') });
    expect(cachedInbox().conversations[0]?.id).toBe('c-2');
  });

  it.each([false, true])(
    'preserves delayed replay order and the latest preview with buffered snapshots=%s',
    async (buffered) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-23T12:00:10.000Z'));
      await loadThread();
      const listResponse = deferred<ConversationsResponse>();
      const threadResponse = deferred<MessagesResponse>();
      const refreshes: Promise<unknown>[] = [];
      if (buffered) {
        vi.mocked(getConversations).mockReturnValueOnce(listResponse.promise);
        vi.mocked(getMessages).mockReturnValueOnce(threadResponse.promise);
        refreshes.push(loadInbox(), loadThread());
      }
      const events: LiveEvent[] = [
        start(11),
        token(12, 'AI answer'),
        end(13),
        {
          id: 14,
          type: 'message',
          conversationId: 'c-1',
          message: {
            ...message('customer-1', 'c-1', 'New question'),
            createdAt: '2026-11-23T12:00:03.000Z',
          },
        },
      ];
      events.forEach(emit);
      if (buffered) {
        listResponse.resolve(inbox(10));
        threadResponse.resolve({ lastEventId: 10, messages: [] });
        await Promise.all(refreshes);
      }
      events.slice(1).forEach(emit);
      expect(cachedThread()?.messages.map(({ text }) => text)).toEqual(['AI answer', 'New question']);
      expect(cachedInbox().conversations.find(({ id }) => id === 'c-1')).toMatchObject({
        unread: 1,
        lastMessage: 'New question',
      });
      expect(live.store.getState().streams).toEqual({});
      expect(connection.getCursor()).toBe(14);
    },
  );

  it.each<LiveEvent>([
    { id: 11, type: 'status', conversationId: 'c-1', status: 'needs_human' },
    {
      id: 11,
      type: 'tool_call',
      conversationId: 'c-1',
      name: 'transfer_to_human',
      args: { reason: 'Billing question' },
    },
  ])('does not let delayed $type receipt time hide a later customer preview', async (event) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T12:00:10.000Z'));
    emit(event);
    emit({
      id: 12,
      type: 'message',
      conversationId: 'c-1',
      message: {
        ...message('customer-1', 'c-1', 'New question'),
        createdAt: '2026-11-23T12:00:03.000Z',
      },
    });
    expect(cachedInbox().conversations.find(({ id }) => id === 'c-1')).toMatchObject({
      status: 'needs_human',
      unread: 1,
      lastMessage: 'New question',
    });
    expect(connection.getCursor()).toBe(12);
  });

  it('keeps token updates out of the Query cache and preserves the large history array', async () => {
    vi.mocked(getMessages).mockResolvedValue({
      lastEventId: 10,
      messages: Array.from({ length: 5000 }, (_, i) => message(`m-${i}`)),
    });
    await loadThread();
    emit(start(11));
    const history = cachedThread()?.messages;
    const write = vi.spyOn(client, 'setQueryData');
    emit(token(12, 'One '));
    emit(token(13, 'two'));
    expect(write).not.toHaveBeenCalled();
    expect(cachedThread()?.messages).toBe(history);
    expect(live.store.getState().streams['c-1']?.text).toBe('One two');
  });

  it('combines a partial snapshot with later buffered tokens and completion', async () => {
    await loadThread();
    emit(start(11));
    emit(token(12, 'Hello '));
    const response = deferred<MessagesResponse>();
    vi.mocked(getMessages).mockReturnValueOnce(response.promise);
    const refreshed = loadThread();
    emit(token(13, 'world'));
    emit(end(14));
    response.resolve({
      lastEventId: 12,
      messages: [{ ...message('ai-1', 'c-1', 'Hello '), role: 'ai', streaming: true }],
    });
    await refreshed;
    expect(cachedThread()?.messages).toHaveLength(1);
    expect(cachedThread()?.messages[0]).toMatchObject({ text: 'Hello world', streaming: false });
    expect(live.store.getState().streams).toEqual({});
  });

  it('replays only events newer than an inbox snapshot without double-counting unread', async () => {
    const response = deferred<ConversationsResponse>();
    vi.mocked(getConversations).mockReturnValueOnce(response.promise);
    const refreshed = loadInbox();
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: message('m-1') });
    emit({ id: 12, type: 'message', conversationId: 'c-1', message: message('m-2', 'c-1', 'Second') });
    const snapshot = inbox(11);
    snapshot.conversations[0]!.unread = 1;
    snapshot.conversations[0]!.lastMessage = 'Hello';
    response.resolve(snapshot);
    await refreshed;
    expect(cachedInbox().conversations[0]).toMatchObject({ unread: 2, lastMessage: 'Second' });
  });

  it('does not let a future thread snapshot skip inbox events or append snapshot tokens twice', async () => {
    vi.mocked(getMessages).mockResolvedValue({
      lastEventId: 13,
      messages: [message('m-1'), { ...message('ai-1'), role: 'ai', streaming: true }],
    });
    await loadThread();
    expect(connection.getCursor()).toBe(10);
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: message('m-1') });
    emit(start(12));
    emit(token(13, 'Hello'));
    emit(end(14));
    expect(cachedInbox().conversations[0]).toMatchObject({ unread: 1, lastMessage: 'Hello' });
    expect(cachedThread()?.messages.map(({ text }) => text)).toEqual(['Hello', 'Hello']);
    expect(cachedThread()?.messages[1]?.streaming).toBe(false);
  });

  it('uses completed snapshot text when its watermark already covers a pending end event', async () => {
    emit(start(11));
    emit(token(12, 'Hello'));
    vi.mocked(getMessages).mockResolvedValue({
      lastEventId: 13,
      messages: [{ ...message('ai-1'), role: 'ai' }],
    });
    await loadThread();
    expect(live.store.getState().streams).toEqual({});
    emit(end(13));
    expect(cachedInbox().conversations[0]?.lastMessage).toBe('Hello');
  });

  it('keeps the global cursor separate from a newer inbox snapshot so cached threads catch up', async () => {
    await loadThread();
    const snapshot = inbox(11);
    snapshot.conversations[0]!.unread = 1;
    snapshot.conversations[0]!.lastMessage = 'Hello';
    vi.mocked(getConversations).mockResolvedValueOnce(snapshot);
    await loadInbox();
    expect(connection.getCursor()).toBe(10);
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: message('m-1') });
    expect(cachedThread()?.messages).toEqual([message('m-1')]);
    expect(cachedInbox().conversations[0]?.unread).toBe(1);
  });

  it('updates cached offscreen threads without creating incomplete caches for unvisited threads', async () => {
    await loadThread('c-2');
    emit({ id: 11, type: 'message', conversationId: 'c-2', message: message('m-2', 'c-2') });
    emit({ id: 12, type: 'message', conversationId: 'c-1', message: message('m-1') });
    emit(start(13));
    emit(token(14, 'Live'));
    emit(end(15));
    expect(cachedThread('c-2')?.messages).toEqual([message('m-2', 'c-2')]);
    expect(cachedThread('c-1')).toBeUndefined();
    expect(cachedInbox().conversations.find(({ id }) => id === 'c-1')).toMatchObject({
      unread: 1,
      lastMessage: 'Live',
    });
  });

  it('hydrates an unknown stream once and preserves the snapshot prefix', async () => {
    await loadThread();
    const response = deferred<MessagesResponse>();
    vi.mocked(getMessages).mockReturnValueOnce(response.promise);
    emit(token(11, 'Hello '));
    emit(token(12, 'world'));
    emit(end(13));
    expect(getMessages).toHaveBeenCalledTimes(2);
    response.resolve({
      lastEventId: 11,
      messages: [{ ...message('ai-1', 'c-1', 'Hello '), role: 'ai', streaming: true }],
    });
    await vi.waitFor(() =>
      expect(cachedThread()?.messages[0]).toMatchObject({ text: 'Hello world', streaming: false }),
    );
    expect(live.store.getState().streams).toEqual({});
  });

  it('refreshes the inbox preview when an unknown stream ends during the first thread request', async () => {
    const observer = new QueryObserver(client, {
      queryKey: ['conversations'],
      queryFn: ({ signal }) => live.loadConversations(signal),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      const response = deferred<MessagesResponse>();
      vi.mocked(getMessages).mockReturnValueOnce(response.promise);
      const requested = loadThread();
      emit(token(11, 'Hello'));
      emit(end(12));
      const updated = inbox(12);
      updated.conversations[0]!.lastMessage = 'Hello';
      vi.mocked(getConversations).mockResolvedValueOnce(updated);
      response.resolve({ lastEventId: 11, messages: [{ ...message('ai-1'), role: 'ai', streaming: true }] });
      await requested;
      await vi.waitFor(() => expect(cachedInbox().conversations[0]?.lastMessage).toBe('Hello'));
      expect(cachedThread()?.messages[0]).toMatchObject({ text: 'Hello', streaming: false });
      expect(getMessages).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
    }
  });

  it('ignores a superseded response so it cannot replace a newer stream prefix', async () => {
    const older = deferred<MessagesResponse>();
    vi.mocked(getMessages).mockReturnValueOnce(older.promise);
    const stale = live.loadMessages('c-1');
    const rejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    vi.mocked(getMessages).mockResolvedValueOnce({
      lastEventId: 12,
      messages: [{ ...message('ai-1', 'c-1', 'Latest'), role: 'ai', streaming: true }],
    });
    await loadThread();
    older.resolve({ lastEventId: 10, messages: [] });
    await rejected;
    expect(live.store.getState().streams['c-1']?.text).toBe('Latest');
  });

  it('preserves observed handoff reasons across authoritative list refreshes', async () => {
    emit({
      id: 11,
      type: 'tool_call',
      conversationId: 'c-1',
      name: 'transfer_to_human',
      args: { reason: 'Customer requested help' },
    });
    emit({ id: 12, type: 'status', conversationId: 'c-1', status: 'needs_human' });
    const snapshot = inbox(12);
    snapshot.conversations[0]!.status = 'needs_human';
    vi.mocked(getConversations).mockResolvedValueOnce(snapshot);
    await loadInbox();
    expect(live.store.getState().handoffs['c-1']).toBe('Customer requested help');
    expect(cachedInbox().conversations[0]?.status).toBe('needs_human');
  });

  it('discards buffered events and overlays from the old server after its counter resets', async () => {
    await loadThread();
    emit(start(11));
    emit(token(12, 'Old server'));
    const response = deferred<ConversationsResponse>();
    vi.mocked(getConversations).mockReturnValueOnce(response.promise);
    const refreshed = loadInbox();
    emit({ id: 13, type: 'message', conversationId: 'c-1', message: message('old-message') });
    response.resolve(inbox(0));
    await refreshed;
    expect(connection.getCursor()).toBe(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(live.store.getState().streams).toEqual({});
    expect(cachedInbox().conversations[0]).toMatchObject({ unread: 0, lastMessage: 'Previous' });
    emit({
      id: 1,
      type: 'message',
      conversationId: 'c-1',
      message: message('new-message', 'c-1', 'New server'),
    });
    expect(cachedInbox().conversations[0]).toMatchObject({ unread: 1, lastMessage: 'New server' });
  });

  it('closes one connection on stop and resumes from its latest accepted cursor', () => {
    emit(start(11));
    live.stop();
    emit(token(12, 'Ignored'));
    expect(live.store.getState().streams['c-1']?.text).toBe('');
    live.start();
    expect(connectEvents).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(connection.getCursor()).toBe(11);
  });

  it('keeps a resumed connection healthy when the previous recovery request is cancelled', async () => {
    const response = deferred<MessagesResponse>();
    vi.mocked(getMessages).mockReturnValueOnce(response.promise);
    emit(token(11, 'Unknown stream'));
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(client.getQueryState(['messages', 'c-1'])?.fetchStatus).toBe('fetching');
    live.stop();
    live.start();
    connection.onStatus('connected');
    response.reject(new DOMException('Request cancelled.', 'AbortError'));
    // Let both React Query cancellation and the deferred request rejection settle.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(client.getQueryState(['messages', 'c-1'])?.fetchStatus).toBe('idle');
    expect(live.store.getState().connection).toBe('connected');
  });
});
