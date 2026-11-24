// @vitest-environment jsdom
import { I18nProvider } from '@heroui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message, MessagesResponse } from '../../../domain/conversation';
import { messages as copy, type Locale } from '../../../i18n/messages';
import { createLiveStore } from '../live/store';
import { ConversationThread } from './ConversationThread';

let store: ReturnType<typeof createLiveStore>;
let client: QueryClient;
const renderHistory = vi.fn<(messages: Message[]) => void>();
vi.mock('../live/LiveProvider', () => ({ useConversationLive: () => ({ store }) }));
vi.mock('./MessageList', async () => {
  const { memo } = await import('react');
  return {
    MessageList: memo(({ messages }: { messages: Message[] }) => {
      renderHistory(messages);
      return null;
    }),
  };
});

const pending: Message = {
  id: 'pending-reply',
  conversationId: 'c-1',
  role: 'human',
  text: 'My reply',
  createdAt: '2026-11-24T12:00:00.000Z',
  clientMessageId: 'reply-attempt',
};
const latestHistory = () => renderHistory.mock.calls.at(-1)![0];
const tree = (locale: Locale = 'en') => (
  <QueryClientProvider client={client}>
    <I18nProvider locale={locale}>
      <ConversationThread conversationId="c-1" customerName="Sara" status="human" />
    </I18nProvider>
  </QueryClientProvider>
);

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: 0, retry: false } } });
  client.setQueryData<MessagesResponse>(['messages', 'c-1'], {
    lastEventId: 10,
    messages: Array.from({ length: 5000 }, (_, index) => ({
      id: `m-${index}`,
      conversationId: 'c-1',
      role: 'customer',
      text: `Earlier message ${index}`,
      createdAt: pending.createdAt,
    })),
  });
  store = createLiveStore();
  store.setState({ sends: { 'c-1': { message: pending, status: 'sending', afterMessageId: 'm-4999', order: 1 } } });
  renderHistory.mockClear();
});
afterEach(() => {
  cleanup();
  client.clear();
});

it('keeps the 5,000-message optimistic history stable across delivery metadata changes', () => {
  const { rerender } = render(tree());
  const history = latestHistory();
  expect(history).toHaveLength(5001);
  expect(history.at(-1)).toBe(pending);
  renderHistory.mockClear();

  for (const change of [
    { checking: true },
    { checking: false, error: 'Could not check delivery.' },
    { status: 'uncertain' as const },
    { status: 'failed' as const },
  ]) {
    act(() => store.setState((state) => ({ sends: { 'c-1': { ...state.sends['c-1']!, ...change } } })));
  }
  expect(renderHistory).toHaveBeenCalledTimes(0);

  rerender(tree('ar'));
  expect(screen.getByText(copy.ar.messageCount(5001))).toBeTruthy();
  expect(renderHistory).toHaveBeenCalledTimes(0);
});

it('keeps a failed reply in place through new arrivals and deduplicates its server confirmation', async () => {
  render(tree());
  const incoming: Message = {
    ...pending,
    id: 'incoming',
    role: 'customer',
    text: 'New question',
    clientMessageId: undefined,
  };
  act(() =>
    client.setQueryData<MessagesResponse>(['messages', 'c-1'], (data) => ({
      ...data!,
      messages: [...data!.messages, incoming],
    })),
  );
  await waitFor(() => expect(latestHistory()).toHaveLength(5002));
  expect(latestHistory().at(-2)).toBe(pending);
  expect(latestHistory().at(-1)).toEqual(incoming);

  const history = latestHistory();
  act(() => store.setState((state) => ({ sends: { 'c-1': { ...state.sends['c-1']!, status: 'failed', error: 'Rejected' } } })));
  expect(latestHistory()).toBe(history);
  expect(latestHistory().at(-2)).toBe(pending);

  act(() => store.setState((state) => ({ sends: { 'c-1': { ...state.sends['c-1']!, status: 'uncertain' } } })));
  expect(latestHistory()).toBe(history);

  const confirmed = { ...pending, id: 'server-reply' };
  act(() =>
    client.setQueryData<MessagesResponse>(['messages', 'c-1'], (data) => ({
      ...data!,
      messages: [...data!.messages, confirmed],
    })),
  );
  await waitFor(() => expect(latestHistory().at(-1)?.id).toBe('server-reply'));
  expect(latestHistory()).toHaveLength(5002);
  expect(
    latestHistory().filter((message) => message.clientMessageId === pending.clientMessageId),
  ).toHaveLength(1);
});
