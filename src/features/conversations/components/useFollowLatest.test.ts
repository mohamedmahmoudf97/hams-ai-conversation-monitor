// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Message } from '../../../domain/conversation';
import { useFollowLatest } from './useFollowLatest';

const message = (id: string, clientMessageId?: string): Message => ({
  id,
  conversationId: 'conversation-1',
  role: 'customer',
  text: id,
  createdAt: '2026-11-24T10:00:00.000Z',
  ...(clientMessageId ? { clientMessageId } : {}),
});

let viewport: HTMLDivElement;
const resizeCallbacks = new Set<() => void>();
const scrollToLatest = vi.fn<(behavior?: ScrollBehavior) => void>();
const cancelScroll = vi.fn();

beforeEach(() => {
  scrollToLatest.mockReset().mockImplementation(() => {
    viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
  });
  cancelScroll.mockClear();
  viewport = document.createElement('div');
  viewport.tabIndex = 0;
  viewport.append(document.createElement('div'));
  Object.defineProperties(viewport, {
    clientHeight: { value: 100, configurable: true },
    scrollHeight: { value: 500, configurable: true },
  });
  document.body.append(viewport);
  resizeCallbacks.clear();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(readonly callback: () => void) {}
      observe() {
        resizeCallbacks.add(this.callback);
      }
      disconnect() {
        resizeCallbacks.delete(this.callback);
      }
    },
  );
});

afterEach(() => {
  cleanup();
  viewport.remove();
  vi.unstubAllGlobals();
});

function scroll(top: number) {
  act(() => {
    viewport.scrollTop = top;
    viewport.dispatchEvent(new Event('scroll'));
  });
}

function mount(messages = [message('first')]) {
  return renderHook(({ current }) => useFollowLatest(current, viewport, scrollToLatest, cancelScroll), {
    initialProps: { current: messages },
  });
}

it('does not rescan a 5,000-message history for repeated scroll events while already following', () => {
  let keyReads = 0;
  const history = Array.from({ length: 5000 }, (_, index) => ({
    ...message(`message-${index}`),
    get clientMessageId() {
      keyReads++;
      return undefined;
    },
  }));
  const { result } = mount(history);
  keyReads = 0;
  for (let index = 0; index < 20; index++) scroll(400 - index);
  expect(keyReads).toBe(0);
  expect(result.current.newCount).toBe(0);

  scroll(0);
  scroll(400);
  expect(keyReads).toBe(5000);
  expect(result.current.away).toBe(false);
});

it('follows initially, preserves history on arrival, and clears the count when returning near the bottom', () => {
  const { result, rerender } = mount();
  expect(viewport.scrollTop).toBe(400);
  expect(result.current.away).toBe(false);
  scroll(0);
  rerender({ current: [message('first'), message('second')] });
  expect(viewport.scrollTop).toBe(0);
  expect(result.current.away).toBe(true);
  expect(result.current.newCount).toBe(1);
  scroll(330);
  expect(result.current.away).toBe(false);
  expect(result.current.newCount).toBe(0);
  rerender({ current: [message('first'), message('second'), message('third')] });
  expect(viewport.scrollTop).toBe(400);
  expect(result.current.newCount).toBe(0);
});

it('does not count repeated snapshots, text updates, or optimistic ID confirmation twice', () => {
  const { result, rerender } = mount([message('first'), message('local-seen', 'seen-client')]);
  scroll(0);
  rerender({ current: [message('first'), message('confirmed-seen', 'seen-client')] });
  expect(result.current.newCount).toBe(0);
  const current = [message('first'), message('confirmed-seen', 'seen-client'), message('local', 'client')];
  rerender({ current });
  expect(result.current.newCount).toBe(1);
  rerender({ current: [...current] });
  expect(result.current.newCount).toBe(1);
  rerender({ current: [current[0]!, current[1]!, { ...message('confirmed', 'client'), text: 'Updated' }] });
  expect(result.current.newCount).toBe(1);
  rerender({ current: current.slice(0, 2) });
  expect(result.current.newCount).toBe(0);
});

it('does not count a seen failed bubble as new when retried or confirmed', () => {
  const { result, rerender } = mount([message('first'), message('pending-reply', 'attempt-1')]);
  scroll(0);
  rerender({ current: [message('first'), message('pending-reply', 'attempt-2')] });
  expect(result.current.newCount).toBe(0);
  rerender({ current: [message('first'), message('server-reply', 'attempt-2'), message('incoming')] });
  expect(result.current.newCount).toBe(1);
  expect(viewport.scrollTop).toBe(0);
});

it('follows resizing only at the bottom and returns focus to history when jumping', () => {
  const { result, rerender } = mount();
  scrollToLatest.mockClear();
  act(() => resizeCallbacks.forEach((callback) => callback()));
  expect(scrollToLatest).toHaveBeenCalledTimes(1);
  scroll(0);
  scrollToLatest.mockClear();
  act(() => resizeCallbacks.forEach((callback) => callback()));
  expect(scrollToLatest).not.toHaveBeenCalled();
  rerender({ current: [message('first'), message('second')] });
  act(() => result.current.jumpToLatest());
  expect(viewport.scrollTop).toBe(400);
  expect(document.activeElement).toBe(viewport);
  expect(result.current.away).toBe(false);
  expect(result.current.newCount).toBe(0);
  scrollToLatest.mockClear();
  act(() => resizeCallbacks.forEach((callback) => callback()));
  expect(scrollToLatest).toHaveBeenCalledTimes(1);
});

it('clears the jump state when resizing reveals the latest message without a scroll event', () => {
  const { result, rerender } = mount();
  scroll(0);
  rerender({ current: [message('first'), message('second')] });
  expect(result.current.away).toBe(true);
  expect(result.current.newCount).toBe(1);
  scrollToLatest.mockClear();
  Object.defineProperty(viewport, 'clientHeight', { value: 500 });
  act(() => resizeCallbacks.forEach((callback) => callback()));
  expect(viewport.scrollTop).toBe(0);
  expect(scrollToLatest).not.toHaveBeenCalled();
  expect(result.current.away).toBe(false);
  expect(result.current.newCount).toBe(0);
  rerender({ current: [message('first'), message('second'), message('third')] });
  expect(scrollToLatest).toHaveBeenCalledTimes(1);
  expect(result.current.newCount).toBe(0);
});

it('disconnects observers and scroll listeners on unmount', () => {
  const { unmount } = mount();
  const remove = vi.spyOn(viewport, 'removeEventListener');
  expect(resizeCallbacks.size).toBe(1);
  unmount();
  expect(resizeCallbacks.size).toBe(0);
  expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('wheel', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('touchstart', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
});

it('opens a cached history at the bottom once its scroll element is attached', () => {
  const messages = [message('cached')];
  const { rerender } = renderHook(
    ({ element }: { element: HTMLDivElement | null }) =>
      useFollowLatest(messages, element, scrollToLatest, cancelScroll),
    { initialProps: { element: null as HTMLDivElement | null } },
  );
  scrollToLatest.mockClear();
  rerender({ element: viewport });
  expect(scrollToLatest).toHaveBeenCalledTimes(1);
  expect(viewport.scrollTop).toBe(400);
});

it('jumps smoothly without new messages or resizing interrupting the animation, then resumes following', () => {
  const { result, rerender } = mount();
  scroll(0);
  scrollToLatest.mockClear().mockImplementation((behavior) => {
    if (behavior !== 'smooth') viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight;
  });
  act(() => result.current.jumpToLatest());
  expect(scrollToLatest).toHaveBeenCalledWith('smooth');
  expect(result.current.away).toBe(false);
  scroll(330);
  Object.defineProperty(viewport, 'scrollHeight', { value: 600 });
  rerender({ current: [message('first'), message('second')] });
  act(() => resizeCallbacks.forEach((callback) => callback()));
  expect(scrollToLatest).toHaveBeenCalledTimes(1);
  expect(viewport.scrollTop).toBe(330);
  scroll(500);
  expect(result.current.newCount).toBe(0);
  Object.defineProperty(viewport, 'scrollHeight', { value: 700 });
  rerender({ current: [message('first'), message('second'), message('third')] });
  expect(scrollToLatest).toHaveBeenCalledTimes(2);
  expect(viewport.scrollTop).toBe(600);
  scroll(0);
  rerender({ current: [message('first'), message('second'), message('third')] });
  expect(result.current.newCount).toBe(0);
});

it('finishes a smooth jump when resizing exposes the end without a scroll event', () => {
  const { result, rerender } = mount();
  scroll(0);
  scrollToLatest.mockClear().mockImplementation(() => {});
  act(() => result.current.jumpToLatest());
  rerender({ current: [message('first'), message('second')] });
  expect(result.current.newCount).toBe(1);

  Object.defineProperty(viewport, 'clientHeight', { value: 500 });
  act(() => resizeCallbacks.forEach((callback) => callback()));
  expect(result.current.away).toBe(false);
  expect(result.current.newCount).toBe(0);
  expect(scrollToLatest).toHaveBeenCalledTimes(1);

  rerender({ current: [message('first'), message('second'), message('third')] });
  expect(scrollToLatest).toHaveBeenCalledTimes(2);
  expect(result.current.newCount).toBe(0);
});

it('acknowledges arrivals when the user cancels a smooth jump near the bottom', () => {
  const { result, rerender } = mount();
  scroll(0);
  scrollToLatest.mockClear().mockImplementation(() => {});
  act(() => result.current.jumpToLatest());
  const current = [message('first'), message('second')];
  rerender({ current });
  scroll(330);
  expect(result.current.newCount).toBe(1);
  act(() => viewport.dispatchEvent(new Event('wheel')));
  expect(cancelScroll).toHaveBeenCalledTimes(1);
  expect(result.current.newCount).toBe(0);
  expect(result.current.away).toBe(false);
  scroll(0);
  rerender({ current: [...current] });
  expect(result.current.newCount).toBe(0);
});

it('uses an immediate jump when reduced motion is preferred', () => {
  const matchMedia = vi.fn(() => ({ matches: true }));
  vi.stubGlobal('matchMedia', matchMedia);
  const { result } = mount();
  scroll(0);
  act(() => result.current.jumpToLatest());
  expect(matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
  expect(scrollToLatest).toHaveBeenLastCalledWith('auto');
  expect(viewport.scrollTop).toBe(400);
  expect(result.current.away).toBe(false);
});

it.each(['wheel', 'touchstart', 'keydown'])(
  'lets %s cancel a smooth jump and keeps subsequent arrivals in history',
  (type) => {
    const { result, rerender } = mount();
    scroll(0);
    scrollToLatest.mockClear().mockImplementation(() => {});
    act(() => result.current.jumpToLatest());
    scroll(150);
    act(() =>
      viewport.dispatchEvent(
        type === 'keydown' ? new KeyboardEvent(type, { key: 'PageUp' }) : new Event(type),
      ),
    );
    expect(cancelScroll).toHaveBeenCalledTimes(1);
    expect(result.current.away).toBe(true);
    rerender({ current: [message('first'), message('second')] });
    act(() => resizeCallbacks.forEach((callback) => callback()));
    expect(scrollToLatest).toHaveBeenCalledTimes(1);
    expect(viewport.scrollTop).toBe(150);
    expect(result.current.newCount).toBe(1);
  },
);

it('does not interrupt a jump for unrelated keys', () => {
  const { result } = mount();
  scroll(0);
  scrollToLatest.mockImplementation(() => {});
  act(() => result.current.jumpToLatest());
  act(() => viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' })));
  expect(cancelScroll).not.toHaveBeenCalled();
  expect(result.current.away).toBe(false);
});
