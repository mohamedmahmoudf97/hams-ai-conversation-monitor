// @vitest-environment jsdom
import { I18nProvider } from '@heroui/react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { messages, type Locale } from '../../../i18n/messages';
import type { ConnectionStatus } from '../live/connection';
import { createLiveStore } from '../live/store';
import { ConnectionToast } from './ConnectionToast';

let store: ReturnType<typeof createLiveStore>;
vi.mock('../live/LiveProvider', () => ({ useConversationLive: () => ({ store }) }));

const setStatus = (connection: ConnectionStatus) => act(() => store.setState({ connection }));
const advance = (milliseconds: number) => act(() => vi.advanceTimersByTime(milliseconds));
const tree = (locale: Locale = 'en') => (
  <I18nProvider locale={locale}>
    <ConnectionToast />
  </I18nProvider>
);

beforeEach(() => {
  vi.useFakeTimers();
  store = createLiveStore();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('stays silent initially, updates one loss toast through recovery, and dismisses it after success', () => {
  render(tree());
  expect(screen.queryByRole('alertdialog')).toBeNull();
  setStatus('connected');
  expect(screen.queryByRole('alertdialog')).toBeNull();

  setStatus('disconnected');
  const toast = screen.getByRole('alertdialog', { name: messages.en.connections.disconnected });
  advance(15_000);
  expect(screen.getByRole('alertdialog')).toBe(toast);
  setStatus('reconnecting');
  expect(screen.getByRole('alertdialog', { name: messages.en.connections.reconnecting })).toBe(toast);
  setStatus('connected');
  expect(screen.getByRole('alertdialog', { name: messages.en.connections.connected })).toBe(toast);
  advance(3999);
  expect(screen.getByRole('alertdialog')).toBe(toast);
  advance(301);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('keeps a repeated loss visible after the previous success timeout would have expired', () => {
  render(tree());
  setStatus('disconnected');
  const toast = screen.getByRole('alertdialog');
  setStatus('connected');
  advance(2000);
  setStatus('disconnected');
  advance(6000);
  expect(screen.getAllByRole('alertdialog')).toEqual([toast]);
  expect(screen.getByRole('alertdialog', { name: messages.en.connections.disconnected })).toBe(toast);
});

it('translates the active toast in place and leaves no notifications after unmounting', () => {
  const { rerender, unmount } = render(tree());
  setStatus('disconnected');
  const toast = screen.getByRole('alertdialog');
  rerender(tree('ar'));
  expect(screen.getAllByRole('alertdialog')).toEqual([toast]);
  expect(screen.getByRole('alertdialog', { name: messages.ar.connections.disconnected })).toBe(toast);
  setStatus('connected');
  unmount();
  advance(10_000);
  render(tree('ar'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByText(messages.ar.connections.disconnected)).toBeNull();
});
