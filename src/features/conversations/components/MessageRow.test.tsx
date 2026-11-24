// @vitest-environment jsdom
import { Profiler } from 'react';
import { I18nProvider } from '@heroui/react';
import { QueryClient } from '@tanstack/react-query';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getConversations, getMessages } from '../../../api/client';
import type { ConversationsResponse, Message, MessagesResponse } from '../../../domain/conversation';
import { connectEvents } from '../live/connection';
import { createConversationLive } from '../live/controller';
import { MessageRow } from './MessageRow';

vi.mock('../../../api/client');
vi.mock('../live/connection');
let live: ReturnType<typeof createConversationLive>;
vi.mock('../live/LiveProvider', () => ({ useConversationLive: () => live }));

const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
const createdAt = '2026-11-24T12:00:00.000Z';
const message = (id: string, conversationId = 'c-1', streaming = false): Message => ({
  id,
  conversationId,
  role: streaming ? 'ai' : 'customer',
  text: streaming ? '' : 'Earlier message',
  createdAt,
  streaming,
});

afterEach(() => {
  cleanup();
  live?.stop();
  client.clear();
});

it('commits only the matching message row for interleaved tokens in a 5,000-message history', async () => {
  const active = message('stream-a', 'c-1', true);
  const other = message('stream-b', 'c-2', true);
  const history = [...Array.from({ length: 4999 }, (_, index) => message(`m-${index}`)), active];
  let connection!: Parameters<typeof connectEvents>[0];
  vi.mocked(connectEvents).mockImplementation((options) => {
    connection = options;
    return () => {};
  });
  vi.mocked(getConversations).mockResolvedValue({
    lastEventId: 10,
    conversations: ['c-1', 'c-2'].map((id) => ({
      id,
      customer: id,
      status: 'ai',
      lastMessage: 'Previous',
      unread: 0,
      updatedAt: createdAt,
    })),
  });
  vi.mocked(getMessages).mockImplementation(async (id) => ({
    lastEventId: 10,
    messages: id === 'c-1' ? history : [other],
  }));
  live = createConversationLive(client);
  live.start();
  await client.fetchQuery({ queryKey: ['conversations'], queryFn: () => live.loadConversations() });
  for (const id of ['c-1', 'c-2']) {
    await client.fetchQuery({ queryKey: ['messages', id], queryFn: () => live.loadMessages(id) });
  }
  const confirmed = client.getQueryData<MessagesResponse>(['messages', 'c-1'])!.messages;
  const commits = new Map<string, number>();
  render(
    <I18nProvider locale="en">
      {[history[0]!, active, other].map((row) => (
        <Profiler key={row.id} id={row.id} onRender={(id) => commits.set(id, (commits.get(id) ?? 0) + 1)}>
          <MessageRow message={row} customerName={row.conversationId} />
        </Profiler>
      ))}
    </I18nProvider>,
  );
  commits.clear();

  const tokens = [
    { row: active, text: 'Hello' },
    { row: other, text: 'مرحباً' },
    { row: active, text: ' Premium' },
    { row: other, text: ' بك' },
  ];
  for (const [index, { row, text }] of tokens.entries()) {
    act(() =>
      connection.onEvent({
        id: 11 + index,
        type: 'token',
        conversationId: row.conversationId,
        messageId: row.id,
        text,
      }),
    );
  }

  expect(screen.getByText('Hello Premium')).toBeTruthy();
  expect(screen.getByText('مرحباً بك')).toBeTruthy();
  expect(screen.getByText('Earlier message')).toBeTruthy();
  expect(commits.get(active.id)).toBe(2);
  expect(commits.get(other.id)).toBe(2);
  expect(commits.has(history[0]!.id)).toBe(false);
  expect(client.getQueryData<MessagesResponse>(['messages', 'c-1'])!.messages).toBe(confirmed);
  expect(confirmed).toHaveLength(5000);

  // Completing one stream must not remove or rerender the other stream's overlay.
  commits.clear();
  act(() => connection.onEvent({ id: 15, type: 'message_end', conversationId: 'c-1', messageId: active.id }));
  expect(commits.has(other.id)).toBe(false);
  const finalToken = {
    id: 16,
    type: 'token' as const,
    conversationId: 'c-2',
    messageId: other.id,
    text: ' مجددًا',
  };
  act(() => connection.onEvent(finalToken));
  act(() => connection.onEvent(finalToken));
  expect(screen.getByText('مرحباً بك مجددًا')).toBeTruthy();
  expect(commits.get(other.id)).toBe(1);
  act(() => connection.onEvent({ id: 17, type: 'message_end', conversationId: 'c-2', messageId: other.id }));

  expect(client.getQueryData<MessagesResponse>(['messages', 'c-1'])!.messages.at(-1)).toMatchObject({
    id: active.id,
    text: 'Hello Premium',
    streaming: false,
  });
  expect(client.getQueryData<MessagesResponse>(['messages', 'c-2'])!.messages).toMatchObject([
    { id: other.id, text: 'مرحباً بك مجددًا', streaming: false },
  ]);
  const previews = client.getQueryData<ConversationsResponse>(['conversations'])!.conversations;
  expect(previews.find(({ id }) => id === 'c-1')!.lastMessage).toBe('Hello Premium');
  expect(previews.find(({ id }) => id === 'c-2')!.lastMessage).toBe('مرحباً بك مجددًا');
  expect(live.store.getState().streams).toEqual({});
  expect(connection.getCursor()).toBe(17);
});
