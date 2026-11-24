// @vitest-environment jsdom
import { I18nProvider } from '@heroui/react';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '../../../domain/conversation';
import { messages, type Locale } from '../../../i18n/messages';
import { useTranslation } from '../../../i18n/useTranslation';
import { createLiveStore } from '../live/store';
import { ConversationPreview } from './ConversationPreview';
import { HandoffNotice } from './HandoffNotice';
import { MessageRow } from './MessageRow';

// Count the component bodies through their real hook, not parent Profiler commits.
vi.mock('../../../i18n/useTranslation', { spy: true });

let store: ReturnType<typeof createLiveStore>;
const takeOver = vi.fn();
let live: { store: typeof store; takeOver: typeof takeOver };
vi.mock('../live/LiveProvider', () => ({ useConversationLive: () => live }));

const stream = (conversationId: string, text: string): Message => ({
  id: `stream-${conversationId}`,
  conversationId,
  role: 'ai',
  text,
  createdAt: '2026-11-24T12:00:00.000Z',
  streaming: true,
});

beforeEach(() => {
  store = createLiveStore();
  takeOver.mockReset().mockResolvedValue(undefined);
  live = { store, takeOver };
});
afterEach(cleanup);

it('keeps a stable message object memoized while a changed message still renders', () => {
  const message: Message = { ...stream('c-1', 'Original message'), role: 'customer', streaming: false };
  const view = (row: Message) => (
    <I18nProvider locale="en">
      <MessageRow message={row} customerName="Sara" />
    </I18nProvider>
  );
  const { rerender } = render(view(message));
  vi.mocked(useTranslation).mockClear();
  rerender(view(message));
  expect(useTranslation).not.toHaveBeenCalled();
  expect(screen.getByText('Original message')).toBeTruthy();

  rerender(view({ ...message, text: 'Updated message' }));
  expect(useTranslation).toHaveBeenCalled();
  expect(screen.getByText('Updated message')).toBeTruthy();
});

it('skips unchanged preview props and unrelated streams while snapshot, stream, and locale changes render', () => {
  const view = (lastMessage: string, locale: Locale = 'en', conversationId = 'c-1') => (
    <I18nProvider locale={locale}>
      <ConversationPreview conversationId={conversationId} lastMessage={lastMessage} />
    </I18nProvider>
  );
  const { rerender } = render(view('Previous message'));
  expect(screen.getByText('Previous message')).toBeTruthy();

  vi.mocked(useTranslation).mockClear();
  rerender(view('Previous message'));
  expect(useTranslation).not.toHaveBeenCalled();

  rerender(view('Fresh snapshot'));
  expect(useTranslation).toHaveBeenCalled();
  expect(screen.getByText('Fresh snapshot')).toBeTruthy();

  vi.mocked(useTranslation).mockClear();
  act(() => store.setState({ streams: { 'c-2': stream('c-2', 'Other conversation') } }));
  expect(useTranslation).not.toHaveBeenCalled();

  act(() =>
    store.setState((state) => ({ streams: { ...state.streams, 'c-1': stream('c-1', 'Live reply') } })),
  );
  expect(useTranslation).toHaveBeenCalled();
  expect(screen.getByText('Live reply')).toBeTruthy();
  rerender(view('Newer snapshot'));
  expect(screen.getByText('Live reply')).toBeTruthy();

  act(() =>
    store.setState((state) => ({ streams: { ...state.streams, 'c-1': stream('c-1', '') } })),
  );
  expect(screen.getByText(messages.en.aiReplying)).toBeTruthy();
  rerender(view('Newer snapshot', 'ar'));
  expect(screen.getByText(messages.ar.aiReplying)).toBeTruthy();

  rerender(view('Second snapshot', 'ar', 'c-2'));
  expect(screen.getByText('Other conversation')).toBeTruthy();
  act(() => store.setState({ streams: {} }));
  expect(screen.getByText('Second snapshot')).toBeTruthy();
  rerender(view('', 'ar', 'c-2'));
  expect(screen.getByText(messages.ar.noMessages)).toBeTruthy();
});

it('skips unchanged handoff props while matching store, locale, status, and conversation changes remain live', async () => {
  store.setState({ handoffs: { 'c-1': 'Refund needs approval', 'c-2': 'Billing dispute' } });
  const view = (
    locale: Locale = 'en',
    status: Conversation['status'] = 'needs_human',
    conversationId = 'c-1',
  ) => (
    <I18nProvider locale={locale}>
      <HandoffNotice conversationId={conversationId} status={status} />
    </I18nProvider>
  );
  const { rerender } = render(view());
  expect(screen.getByText('Refund needs approval')).toBeTruthy();

  vi.mocked(useTranslation).mockClear();
  rerender(view());
  expect(useTranslation).not.toHaveBeenCalled();
  act(() =>
    store.setState((state) => ({
      handoffs: { ...state.handoffs, 'c-2': 'Customer requested a person' },
      takeovers: { 'c-2': { pending: true } },
    })),
  );
  expect(useTranslation).not.toHaveBeenCalled();

  act(() =>
    store.setState((state) => ({ handoffs: { ...state.handoffs, 'c-1': 'Supervisor requested' } })),
  );
  expect(useTranslation).toHaveBeenCalled();
  expect(screen.getByText('Supervisor requested')).toBeTruthy();
  act(() => store.setState({ takeovers: { 'c-1': { pending: true } } }));
  expect(screen.getByRole('button', { name: messages.en.takingOver })).toBeTruthy();
  act(() => store.setState({ takeovers: { 'c-1': { pending: false, error: 'Network request failed' } } }));
  expect(screen.getByRole('button', { name: messages.en.retryTakeover })).toBeTruthy();

  rerender(view('ar'));
  expect(screen.getByText(messages.ar.takeoverError)).toBeTruthy();
  expect(screen.getByRole('button', { name: messages.ar.retryTakeover })).toBeTruthy();
  expect(screen.getByText('Supervisor requested')).toBeTruthy();

  rerender(view('ar', 'human'));
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByText('Supervisor requested')).toBeNull();
  rerender(view('ar', 'needs_human', 'c-2'));
  expect(screen.getByText('Customer requested a person')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: messages.ar.takeOver }));
  expect(takeOver).toHaveBeenCalledExactlyOnceWith('c-2');
});
