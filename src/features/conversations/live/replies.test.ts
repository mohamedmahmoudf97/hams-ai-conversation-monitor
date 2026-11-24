import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  getConversations,
  getMessages,
  sendMessage,
  takeOverConversation,
} from '../../../api/client';
import type {
  Conversation,
  ConversationsResponse,
  Message,
  MessagesResponse,
} from '../../../domain/conversation';
import { connectEvents } from './connection';
import { createConversationLive } from './controller';
import type { LiveEvent } from './events';
import { mergeReplyMessages } from './replyMessages';

vi.mock('../../../api/client', async (original) => ({
  ...(await original<typeof import('../../../api/client')>()),
  getConversations: vi.fn(),
  getMessages: vi.fn(),
  sendMessage: vi.fn(),
  takeOverConversation: vi.fn(),
}));
vi.mock('./connection');

const time = (seconds = 0) => new Date(Date.UTC(2026, 10, 23, 12, 0, seconds)).toISOString();
const conversation = (id: string, status: Conversation['status']): Conversation => ({
  id,
  status,
  customer: id,
  lastMessage: 'Previous',
  unread: 0,
  updatedAt: time(),
});
const inbox = (lastEventId = 10): ConversationsResponse => ({
  lastEventId,
  conversations: [
    conversation('c-1', 'human'),
    conversation('c-2', 'needs_human'),
    conversation('c-3', 'closed'),
    conversation('c-4', 'ai'),
  ],
});
const customer = (id: string, conversationId = 'c-1', seconds = 1): Message => ({
  id,
  conversationId,
  role: 'customer',
  text: id,
  createdAt: time(seconds),
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
const emit = (event: LiveEvent) => connection.onEvent(event);
const loadInbox = () =>
  client.fetchQuery({
    queryKey: ['conversations'],
    queryFn: ({ signal }) => live.loadConversations(signal),
    staleTime: 0,
  });
const loadThread = () =>
  client.fetchQuery({
    queryKey: ['messages', 'c-1'],
    queryFn: ({ signal }) => live.loadMessages('c-1', signal),
    staleTime: 0,
  });
const thread = () => client.getQueryData<MessagesResponse>(['messages', 'c-1'])!.messages;
const selected = (id = 'c-1') =>
  client
    .getQueryData<ConversationsResponse>(['conversations'])!
    .conversations.find((item) => item.id === id)!;
const attempt = () => live.store.getState().sends['c-1'];
const confirmation = (message: Message, id = 'server-reply', seconds = 1): Message => ({
  ...message,
  id,
  createdAt: time(seconds),
});

beforeEach(async () => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time());
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(connectEvents).mockImplementation((options) => {
    connection = options;
    return vi.fn();
  });
  vi.mocked(getConversations).mockResolvedValue(inbox());
  vi.mocked(getMessages).mockResolvedValue({ lastEventId: 10, messages: [customer('original', 'c-1', 0)] });
  live = createConversationLive(client);
  live.start();
  await loadInbox();
  await loadThread();
});

afterEach(() => {
  live.stop();
  client.clear();
  vi.useRealTimers();
});

describe('human takeover', () => {
  it('marks a handoff immediately and keeps the reason through refresh', async () => {
    emit({
      id: 11,
      type: 'tool_call',
      conversationId: 'c-4',
      name: 'transfer_to_human',
      args: { reason: 'Billing dispute' },
    });
    expect(selected('c-4').status).toBe('needs_human');
    expect(live.store.getState().handoffs['c-4']).toBe('Billing dispute');
    const updated = inbox(11);
    updated.conversations[3]!.status = 'needs_human';
    vi.mocked(getConversations).mockResolvedValueOnce(updated);
    await loadInbox();
    expect(live.store.getState().handoffs['c-4']).toBe('Billing dispute');
  });

  it('allows only a requested handoff and prevents duplicate takeover submissions', async () => {
    await live.takeOver('c-1');
    await live.takeOver('c-3');
    await live.takeOver('c-4');
    expect(takeOverConversation).not.toHaveBeenCalled();
    const response = deferred<Conversation>();
    vi.mocked(takeOverConversation).mockReturnValueOnce(response.promise);
    const takingOver = live.takeOver('c-2');
    await live.takeOver('c-2');
    expect(takeOverConversation).toHaveBeenCalledTimes(1);
    expect(selected('c-2').status).toBe('needs_human');
    expect(live.store.getState().takeovers['c-2']?.pending).toBe(true);
    response.resolve({ ...conversation('c-2', 'human'), updatedAt: time(1) });
    await takingOver;
    expect(selected('c-2').status).toBe('human');
    expect(live.store.getState().takeovers['c-2']?.pending).toBe(false);
  });

  it('retains a retryable takeover error and merges status without reverting live preview or unread', async () => {
    vi.mocked(takeOverConversation).mockRejectedValueOnce(new ApiError(500, 'Try again'));
    await live.takeOver('c-2');
    expect(selected('c-2').status).toBe('needs_human');
    expect(live.store.getState().takeovers['c-2']?.error).toBe('Try again');
    const response = deferred<Conversation>();
    vi.mocked(takeOverConversation).mockReturnValueOnce(response.promise);
    const retry = live.takeOver('c-2');
    emit({ id: 11, type: 'message', conversationId: 'c-2', message: customer('New question', 'c-2', 2) });
    response.resolve({ ...conversation('c-2', 'human'), updatedAt: time(1) });
    await retry;
    expect(selected('c-2')).toMatchObject({ status: 'human', lastMessage: 'New question', unread: 1 });
    expect(live.store.getState().takeovers['c-2']?.error).toBeUndefined();
  });

  it('does not replace a newer live status with a delayed takeover response', async () => {
    const response = deferred<Conversation>();
    vi.mocked(takeOverConversation).mockReturnValueOnce(response.promise);
    const takingOver = live.takeOver('c-2');
    emit({ id: 11, type: 'status', conversationId: 'c-2', status: 'human' });
    emit({ id: 12, type: 'status', conversationId: 'c-2', status: 'closed' });
    response.resolve({ ...conversation('c-2', 'human'), updatedAt: time(1) });
    await takingOver;
    expect(selected('c-2').status).toBe('closed');
  });

  it('preserves a takeover confirmed while an older inbox snapshot is in flight', async () => {
    const snapshot = deferred<ConversationsResponse>();
    vi.mocked(getConversations).mockReturnValueOnce(snapshot.promise);
    const refresh = loadInbox();
    vi.mocked(takeOverConversation).mockResolvedValueOnce({
      ...conversation('c-2', 'human'),
      updatedAt: time(1),
    });
    await live.takeOver('c-2');
    snapshot.resolve(inbox());
    await refresh;
    expect(selected('c-2').status).toBe('human');
  });
});

describe('optimistic human replies', () => {
  it('rejects empty drafts and non-human threads without posting', async () => {
    live.setDraft('c-1', ' \n ');
    live.setDraft('c-2', 'Not yet');
    live.setDraft('c-3', 'Closed');
    await live.sendReply('c-1');
    await live.sendReply('c-2');
    await live.sendReply('c-3');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(live.store.getState().drafts['c-2']).toBe('Not yet');
  });

  it.each(['POST first', 'SSE first'])(
    '%s leaves one confirmed reply and does not overwrite the next draft',
    async (order) => {
      const response = deferred<Message>();
      vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
      live.setDraft('c-1', '  مرحباً Premium  ');
      const sending = live.sendReply('c-1');
      const pending = attempt()!.message;
      expect(attempt()?.status).toBe('sending');
      expect(pending.text).toBe('مرحباً Premium');
      expect(thread()).toHaveLength(1);
      expect(live.store.getState().drafts['c-1']).toBe('');
      live.setDraft('c-1', 'Next reply');
      await live.sendReply('c-1');
      expect(sendMessage).toHaveBeenCalledTimes(1);
      const confirmed = confirmation(pending);
      const echo: LiveEvent = { id: 11, type: 'message', conversationId: 'c-1', message: confirmed };
      if (order === 'SSE first') emit(echo);
      response.resolve(confirmed);
      await sending;
      if (order === 'POST first') emit(echo);
      emit(echo);
      expect(thread().filter((message) => message.clientMessageId === pending.clientMessageId)).toEqual([
        confirmed,
      ]);
      expect(attempt()).toBeUndefined();
      expect(live.store.getState().drafts['c-1']).toBe('Next reply');
      expect(selected()).toMatchObject({ lastMessage: confirmed.text, unread: 0 });
    },
  );

  it.each([400, 409, 500])(
    'marks a rejected %s reply failed while preserving newer drafts and live messages',
    async (status) => {
      const response = deferred<Message>();
      vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
      live.setDraft('c-1', 'Failed reply');
      const sending = live.sendReply('c-1');
      live.setDraft('c-1', 'New draft');
      emit({ id: 11, type: 'message', conversationId: 'c-1', message: customer('Incoming') });
      response.reject(new ApiError(status, 'Rejected by server'));
      await sending;
      expect(attempt()).toMatchObject({
        status: 'failed',
        message: { text: 'Failed reply' },
        error: 'Rejected by server',
      });
      expect(thread().map(({ id }) => id)).toEqual(['original', 'Incoming']);
      expect(live.store.getState().drafts['c-1']).toBe('New draft');
      expect(selected()).toMatchObject({ unread: 1, lastMessage: 'Incoming' });
      if (status === 409) expect(client.getQueryState(['conversations'])?.isInvalidated).toBe(true);
    },
  );

  it.each(['SSE', 'snapshot'])(
    'commits %s confirmation before removing the optimistic row',
    async (source) => {
      const response = deferred<Message>();
      vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
      live.setDraft('c-1', 'Keep visible during confirmation');
      const sending = live.sendReply('c-1');
      const confirmed = confirmation(attempt()!.message);
      const committedRowsAtRemoval: Message[][] = [];
      const unsubscribe = live.store.subscribe((state, previous) => {
        if (previous.sends['c-1'] && !state.sends['c-1']) committedRowsAtRemoval.push(thread());
      });
      try {
        if (source === 'SSE') {
          emit({ id: 11, type: 'message', conversationId: 'c-1', message: confirmed });
        } else {
          vi.mocked(getMessages).mockResolvedValueOnce({
            lastEventId: 11,
            messages: [customer('original', 'c-1', 0), confirmed],
          });
          await loadThread();
        }
        expect(committedRowsAtRemoval).toEqual([[customer('original', 'c-1', 0), confirmed]]);
      } finally {
        unsubscribe();
        response.resolve(confirmed);
        await sending;
      }
    },
  );

  it('keeps failed text in its bubble and retries in place without restoring or clearing the draft', async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new ApiError(500, 'Try again'));
    live.setDraft('c-1', 'Recoverable');
    await live.sendReply('c-1');
    const previous = attempt()!;
    expect(live.store.getState().drafts['c-1']).toBe('');
    const response = deferred<Message>();
    vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
    live.setDraft('c-1', 'Recoverable');
    vi.setSystemTime(time(30));
    const retry = live.retryReply('c-1', previous.message.id);
    expect(attempt()?.message.clientMessageId).not.toBe(previous.message.clientMessageId);
    expect(attempt()).toMatchObject({
      message: { id: previous.message.id, createdAt: previous.message.createdAt },
      afterMessageId: previous.afterMessageId,
      order: previous.order,
    });
    expect(vi.mocked(sendMessage).mock.calls[1]?.[1].text).toBe('Recoverable');
    response.resolve(confirmation(attempt()!.message));
    await retry;
    expect(live.store.getState().drafts['c-1']).toBe('Recoverable');
    expect(attempt()).toBeUndefined();
  });

  it('retains multiple failed bubbles and retries only the selected archive without moving its position', async () => {
    vi.mocked(sendMessage).mockRejectedValue(new ApiError(500, 'Try again'));
    live.setDraft('c-1', 'First failed reply');
    await live.sendReply('c-1');
    const first = attempt()!;
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: customer('Incoming') });
    for (const text of ['Second failed reply', 'Third failed reply']) {
      live.setDraft('c-1', text);
      await live.sendReply('c-1');
    }
    const second = live.store.getState().failedReplies['c-1']![1]!;
    const third = attempt()!;
    const visible = () =>
      mergeReplyMessages(thread(), [...(live.store.getState().failedReplies['c-1'] ?? []), attempt()!]);
    expect(visible().map(({ text }) => text)).toEqual([
      'original',
      'First failed reply',
      'Incoming',
      'Second failed reply',
      'Third failed reply',
    ]);
    expect(live.store.getState().drafts['c-1']).toBe('');

    const response = deferred<Message>();
    vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
    live.setDraft('c-1', first.message.text);
    const retry = live.retryReply('c-1', first.message.id);
    expect(attempt()?.message.id).toBe(first.message.id);
    expect(attempt()?.message.createdAt).toBe(first.message.createdAt);
    expect(attempt()?.message.clientMessageId).not.toBe(first.message.clientMessageId);
    expect(live.store.getState().failedReplies['c-1']).toEqual([second, third]);
    expect(live.store.getState().failedReplies['c-1']![0]).toBe(second);
    expect(visible().map(({ text }) => text)).toEqual([
      'original',
      'First failed reply',
      'Incoming',
      'Second failed reply',
      'Third failed reply',
    ]);
    const archived = live.store.getState().failedReplies['c-1'];
    await live.retryReply('c-1', second.message.id);
    await live.sendReply('c-1');
    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(live.store.getState().failedReplies['c-1']).toBe(archived);
    response.reject(new ApiError(500, 'Still rejected'));
    await retry;
    expect(attempt()?.status).toBe('failed');
    expect(live.store.getState().failedReplies['c-1']).toBe(archived);
    expect(live.store.getState().drafts['c-1']).toBe(first.message.text);
  });

  it('keeps archived failures untouched while uncertain delivery is checked or explicitly resent', async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new ApiError(500, 'Rejected'));
    live.setDraft('c-1', 'Earlier failure');
    await live.sendReply('c-1');
    const failed = attempt()!;
    vi.mocked(sendMessage).mockRejectedValueOnce(new TypeError('Network lost'));
    live.setDraft('c-1', 'Uncertain reply');
    await live.sendReply('c-1');
    const uncertain = attempt()!;
    const archived = live.store.getState().failedReplies['c-1'];
    expect(uncertain.status).toBe('uncertain');
    await live.retryReply('c-1', failed.message.id);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    vi.mocked(getMessages).mockRejectedValueOnce(new TypeError('Still offline'));
    await live.checkDelivery('c-1');
    expect(attempt()?.message).toBe(uncertain.message);
    expect(live.store.getState().failedReplies['c-1']).toBe(archived);

    const response = deferred<Message>();
    vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
    const resend = live.retryReply('c-1', uncertain.message.id);
    expect(attempt()?.message.id).toBe(uncertain.message.id);
    expect(attempt()?.message.clientMessageId).not.toBe(uncertain.message.clientMessageId);
    response.resolve(confirmation(attempt()!.message));
    await resend;
    expect(attempt()).toBeUndefined();
    expect(live.store.getState().failedReplies['c-1']).toBe(archived);
  });

  it('keeps uncertain delivery after an absent snapshot, never auto-resends, and accepts a late echo', async () => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new TypeError('Network lost'));
    live.setDraft('c-1', 'May be delivered');
    await live.sendReply('c-1');
    const pending = attempt()!.message;
    expect(attempt()).toMatchObject({ status: 'uncertain', checking: false });
    expect(getMessages).toHaveBeenCalledTimes(2);
    live.setDraft('c-1', 'Do not resend automatically');
    await live.sendReply('c-1');
    await live.checkDelivery('c-1');
    expect(sendMessage).toHaveBeenCalledTimes(1);
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: confirmation(pending) });
    expect(attempt()).toBeUndefined();
    expect(thread()).toHaveLength(2);
    expect(live.store.getState().drafts['c-1']).toBe('Do not resend automatically');
  });

  it('accepts a snapshot confirmation ahead of the stream without duplicating the eventual echo', async () => {
    const response = deferred<Message>();
    vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
    live.setDraft('c-1', 'Snapshot confirmed');
    const sending = live.sendReply('c-1');
    const confirmed = confirmation(attempt()!.message);
    vi.mocked(getMessages).mockResolvedValueOnce({
      lastEventId: 11,
      messages: [customer('original', 'c-1', 0), confirmed],
    });
    await loadThread();
    expect(attempt()).toBeUndefined();
    response.reject(new TypeError('Response was lost'));
    await sending;
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: confirmed });
    expect(thread()).toEqual([customer('original', 'c-1', 0), confirmed]);
    expect(attempt()).toBeUndefined();
  });

  it('does not restore failure after SSE has already confirmed the reply', async () => {
    const response = deferred<Message>();
    vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
    live.setDraft('c-1', 'Already delivered');
    const sending = live.sendReply('c-1');
    const confirmed = confirmation(attempt()!.message);
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: confirmed });
    response.reject(new ApiError(500, 'Late response failure'));
    await sending;
    expect(attempt()).toBeUndefined();
    expect(live.store.getState().drafts['c-1']).toBe('');
    expect(thread()).toContainEqual(confirmed);
  });

  it('ignores a late POST confirmation after SSE acknowledged it and its thread cache was removed', async () => {
    const response = deferred<Message>();
    vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
    live.setDraft('c-1', 'Already delivered');
    const sending = live.sendReply('c-1');
    const confirmed = confirmation(attempt()!.message);
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: confirmed });
    client.removeQueries({ queryKey: ['messages', 'c-1'], exact: true });
    emit({ id: 12, type: 'message', conversationId: 'c-1', message: customer('Newer question', 'c-1', 2) });
    response.resolve(confirmed);
    await sending;
    expect(selected().lastMessage).toBe('Newer question');
    emit({ id: 13, type: 'message', conversationId: 'c-1', message: customer('Newest question', 'c-1', 3) });
    expect(selected().lastMessage).toBe('Newest question');
    expect(attempt()).toBeUndefined();
  });

  it('does not let an old POST completion clear a newer in-flight attempt', async () => {
    const firstResponse = deferred<Message>();
    const secondResponse = deferred<Message>();
    vi.mocked(sendMessage)
      .mockReturnValueOnce(firstResponse.promise)
      .mockReturnValueOnce(secondResponse.promise);
    live.setDraft('c-1', 'First');
    const firstSend = live.sendReply('c-1');
    const first = confirmation(attempt()!.message, 'first');
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: first });
    live.setDraft('c-1', 'Second');
    const secondSend = live.sendReply('c-1');
    const second = confirmation(attempt()!.message, 'second', 2);
    firstResponse.resolve(first);
    await firstSend;
    expect(attempt()?.message.clientMessageId).toBe(second.clientMessageId);
    expect(attempt()?.status).toBe('sending');
    secondResponse.resolve(second);
    await secondSend;
    expect(thread().map(({ text }) => text)).toEqual(['original', 'First', 'Second']);
  });

  it.each(['none', 'before echo', 'after newer message'] as const)(
    'keeps a POST-ahead reply after delayed replay with snapshots resolving %s',
    async (refresh) => {
      vi.setSystemTime(time(10));
      const oldThread = deferred<MessagesResponse>();
      const oldInbox = deferred<ConversationsResponse>();
      const refreshes: Promise<unknown>[] = [];
      if (refresh !== 'none') {
        vi.mocked(getMessages).mockReturnValueOnce(oldThread.promise);
        vi.mocked(getConversations).mockReturnValueOnce(oldInbox.promise);
        refreshes.push(loadThread(), loadInbox());
      }
      const refreshed = Promise.allSettled(refreshes);
      const finishRefresh = async () => {
        oldThread.resolve({ lastEventId: 10, messages: [customer('original', 'c-1', 0)] });
        oldInbox.resolve(inbox());
        expect((await refreshed).every(({ status }) => status === 'fulfilled')).toBe(true);
      };
      const response = deferred<Message>();
      vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
      live.setDraft('c-1', 'My newest reply');
      const sending = live.sendReply('c-1');
      const confirmed = confirmation(attempt()!.message, 'reply', 3);
      response.resolve(confirmed);
      await sending;
      emit({ id: 11, type: 'message_start', conversationId: 'c-1', messageId: 'old-ai', role: 'ai' });
      emit({ id: 12, type: 'token', conversationId: 'c-1', messageId: 'old-ai', text: 'Older AI answer' });
      emit({ id: 13, type: 'message_end', conversationId: 'c-1', messageId: 'old-ai' });
      emit({ id: 14, type: 'message', conversationId: 'c-1', message: customer('Older question', 'c-1', 2) });
      if (refresh === 'before echo') await finishRefresh();
      expect(thread().map(({ text }) => text)).toEqual([
        'original',
        'Older AI answer',
        'Older question',
        'My newest reply',
      ]);
      expect(selected()).toMatchObject({ lastMessage: 'My newest reply', unread: 1 });
      emit({ id: 15, type: 'message', conversationId: 'c-1', message: confirmed });
      emit({
        id: 16,
        type: 'message',
        conversationId: 'c-1',
        message: customer('Newest question', 'c-1', 4),
      });
      if (refresh === 'after newer message') await finishRefresh();
      expect(thread().map(({ text }) => text)).toEqual([
        'original',
        'Older AI answer',
        'Older question',
        'My newest reply',
        'Newest question',
      ]);
      expect(selected()).toMatchObject({ lastMessage: 'Newest question', unread: 2 });
      expect(thread().filter(({ id }) => id === confirmed.id)).toHaveLength(1);
      expect(connection.getCursor()).toBe(16);
    },
  );

  it.each(['thread', 'inbox'] as const)(
    'keeps the other resource ordered when a %s snapshot sees a reply before its SSE echo',
    async (resource) => {
      vi.setSystemTime(time(10));
      const response = deferred<Message>();
      vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
      live.setDraft('c-1', 'Confirmed reply');
      const sending = live.sendReply('c-1');
      const confirmed = confirmation(attempt()!.message, 'reply', 3);
      response.resolve(confirmed);
      await sending;
      const earlier = customer('Earlier customer', 'c-1', 2);
      if (resource === 'thread') {
        vi.mocked(getMessages).mockResolvedValueOnce({
          lastEventId: 12,
          messages: [customer('original', 'c-1', 0), earlier, confirmed],
        });
        await loadThread();
      } else {
        const snapshot = inbox(12);
        snapshot.conversations[0] = {
          ...selected(),
          lastMessage: confirmed.text,
          updatedAt: time(3),
          unread: 1,
        };
        vi.mocked(getConversations).mockResolvedValueOnce(snapshot);
        await loadInbox();
      }
      emit({ id: 11, type: 'message', conversationId: 'c-1', message: earlier });
      expect(thread().map(({ text }) => text)).toEqual(['original', 'Earlier customer', 'Confirmed reply']);
      expect(selected().lastMessage).toBe('Confirmed reply');
      emit({ id: 12, type: 'message', conversationId: 'c-1', message: confirmed });
      emit({
        id: 13,
        type: 'message',
        conversationId: 'c-1',
        message: customer('Newest customer', 'c-1', 4),
      });
      expect(thread().map(({ text }) => text)).toEqual([
        'original',
        'Earlier customer',
        'Confirmed reply',
        'Newest customer',
      ]);
      expect(selected()).toMatchObject({ lastMessage: 'Newest customer', unread: 2 });
    },
  );

  it('keeps a later AI completion preview through a stale inbox refresh when the client clock is behind', async () => {
    const oldInbox = deferred<ConversationsResponse>();
    vi.mocked(getConversations).mockReturnValueOnce(oldInbox.promise);
    const refreshing = loadInbox();
    emit({ id: 11, type: 'status', conversationId: 'c-1', status: 'ai' });
    emit({ id: 12, type: 'message_start', conversationId: 'c-1', messageId: 'ai', role: 'ai' });
    emit({
      id: 13,
      type: 'token',
      conversationId: 'c-1',
      messageId: 'ai',
      text: 'AI finishing after takeover',
    });
    emit({ id: 14, type: 'status', conversationId: 'c-1', status: 'human' });
    const response = deferred<Message>();
    vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
    live.setDraft('c-1', 'Human reply');
    const sending = live.sendReply('c-1');
    const confirmed = confirmation(attempt()!.message, 'reply', 3);
    response.resolve(confirmed);
    await sending;
    emit({ id: 15, type: 'message', conversationId: 'c-1', message: confirmed });
    emit({ id: 16, type: 'message_end', conversationId: 'c-1', messageId: 'ai' });
    oldInbox.resolve(inbox());
    await refreshing;
    expect(selected().lastMessage).toBe('AI finishing after takeover');
    expect(thread().map(({ text }) => text)).toEqual([
      'original',
      'AI finishing after takeover',
      'Human reply',
    ]);
  });

  it('keeps the second POST-ahead reply protected when the first echo arrives', async () => {
    const confirmed: Message[] = [];
    vi.mocked(sendMessage).mockImplementation(async (id, body) => {
      const message = confirmation(
        {
          id: 'pending',
          conversationId: id,
          role: 'human',
          createdAt: time(),
          ...body,
        },
        `reply-${confirmed.length}`,
        confirmed.length + 2,
      );
      confirmed.push(message);
      return message;
    });
    live.setDraft('c-1', 'First reply');
    await live.sendReply('c-1');
    live.setDraft('c-1', 'Second reply');
    await live.sendReply('c-1');
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: customer('Older question') });
    emit({ id: 12, type: 'message', conversationId: 'c-1', message: confirmed[0]! });
    expect(thread().map(({ text }) => text)).toEqual([
      'original',
      'Older question',
      'First reply',
      'Second reply',
    ]);
    expect(selected().lastMessage).toBe('Second reply');
    emit({ id: 13, type: 'message', conversationId: 'c-1', message: confirmed[1]! });
    emit({ id: 14, type: 'message', conversationId: 'c-1', message: customer('Newest question', 'c-1', 4) });
    expect(thread().map(({ text }) => text)).toEqual([
      'original',
      'Older question',
      'First reply',
      'Second reply',
      'Newest question',
    ]);
    expect(selected()).toMatchObject({ lastMessage: 'Newest question', unread: 2 });
  });

  it('preserves POST confirmation and later live messages through older thread and inbox snapshots', async () => {
    const oldThread = deferred<MessagesResponse>();
    const oldInbox = deferred<ConversationsResponse>();
    vi.mocked(getMessages).mockReturnValueOnce(oldThread.promise);
    vi.mocked(getConversations).mockReturnValueOnce(oldInbox.promise);
    const refreshingThread = loadThread();
    const refreshingInbox = loadInbox();
    const response = deferred<Message>();
    vi.mocked(sendMessage).mockReturnValueOnce(response.promise);
    live.setDraft('c-1', 'Confirmed during refresh');
    const sending = live.sendReply('c-1');
    const confirmed = confirmation(attempt()!.message);
    response.resolve(confirmed);
    await sending;
    emit({ id: 11, type: 'message', conversationId: 'c-1', message: confirmed });
    emit({
      id: 12,
      type: 'message',
      conversationId: 'c-1',
      message: customer('Newer live message', 'c-1', 2),
    });
    oldThread.resolve({ lastEventId: 10, messages: [customer('original', 'c-1', 0)] });
    oldInbox.resolve(inbox());
    await Promise.all([refreshingThread, refreshingInbox]);
    expect(thread().map(({ text }) => text)).toEqual([
      'original',
      'Confirmed during refresh',
      'Newer live message',
    ]);
    expect(selected()).toMatchObject({ lastMessage: 'Newer live message', unread: 1 });
    expect(attempt()).toBeUndefined();
  });
});
