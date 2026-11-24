import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiBaseUrl } from '../../../api/config';
import { connectEvents } from './connection';
import type { LiveEvent } from './events';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static failures = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    if (FakeEventSource.failures-- > 0) throw new Error('Connection failed');
    FakeEventSource.instances.push(this);
  }

  send(data: unknown, lastEventId = '') {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data), lastEventId }));
  }
}

const token = { id: 42, type: 'token', conversationId: 'c-1', messageId: 'm-1', text: ' مرحباً' };
const latest = () => FakeEventSource.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  FakeEventSource.failures = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('live connection', () => {
  it('opens from the handled cursor and passes validated replay to the controller', () => {
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const stop = connectEvents({ getCursor: () => 41, onEvent, onStatus });
    expect(latest().url).toBe(`${apiBaseUrl}/events?since=41`);
    expect(onStatus).toHaveBeenLastCalledWith('connecting');
    latest().onopen?.(new Event('open'));
    expect(onStatus).toHaveBeenLastCalledWith('connected');
    latest().send(token, '42');
    latest().send(token, '42');
    // Resource reconciliation and deduplication belong to the controller.
    expect(onEvent.mock.calls).toEqual([[token], [token]]);
    stop();
  });

  it('closes native reconnect and creates one fresh source with the latest cursor', () => {
    let cursor = 41;
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const stop = connectEvents({ getCursor: () => cursor, onEvent, onStatus });
    const old = latest();
    old.onerror?.(new Event('error'));
    old.onerror?.(new Event('error'));
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith('disconnected');
    expect(vi.getTimerCount()).toBe(1);
    cursor = 44;
    vi.advanceTimersByTime(2999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().url).toBe(`${apiBaseUrl}/events?since=44`);
    old.send(token, '42');
    old.onopen?.(new Event('open'));
    old.onerror?.(new Event('error'));
    expect(onEvent).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenLastCalledWith('reconnecting');
    expect(vi.getTimerCount()).toBe(0);
    stop();
    expect(latest().close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['invalid JSON', '{', ''],
    ['invalid payload', JSON.stringify({ ...token, text: null }), '42'],
    ['mismatched frame', JSON.stringify(token), '43'],
  ])('retries %s without delivering it or advancing the cursor', (_, data, lastEventId) => {
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const stop = connectEvents({ getCursor: () => 41, onEvent, onStatus });
    latest().onmessage?.(new MessageEvent('message', { data, lastEventId }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(latest().close).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith('error');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(latest().url).toBe(`${apiBaseUrl}/events?since=41`);
    stop();
  });

  it('retries a gap from the last handled cursor before delivering later events', () => {
    let cursor = 41;
    const onEvent = vi.fn((event: LiveEvent) => { cursor = Math.max(cursor, event.id); });
    const onStatus = vi.fn();
    const stop = connectEvents({ getCursor: () => cursor, onEvent, onStatus });
    const old = latest();
    old.send({ ...token, id: 43 }, '43');
    expect(onEvent).not.toHaveBeenCalled();
    expect(cursor).toBe(41);
    expect(old.close).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith('error');
    expect(vi.getTimerCount()).toBe(1);
    old.send(token, '42');
    expect(onEvent).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(latest().url).toBe(`${apiBaseUrl}/events?since=41`);
    latest().send({ ...token, id: 41 }, '41');
    latest().send(token, '42');
    latest().send({ ...token, id: 43 }, '43');
    expect(onEvent.mock.calls.map(([event]) => event.id)).toEqual([41, 42, 43]);
    expect(cursor).toBe(43);
    stop();
  });

  it('cleanup cancels the pending retry and ignores callbacks from the closed source', () => {
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const stop = connectEvents({ getCursor: () => 0, onEvent, onStatus });
    const old = latest();
    old.onerror?.(new Event('error'));
    stop();
    onStatus.mockClear();
    old.onopen?.(new Event('open'));
    old.send(token);
    old.onerror?.(new Event('error'));
    vi.advanceTimersByTime(30_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('recovers from constructor failure with one retry timer', () => {
    FakeEventSource.failures = 1;
    const onStatus = vi.fn();
    const stop = connectEvents({ getCursor: () => 8, onEvent: vi.fn(), onStatus });
    expect(onStatus).toHaveBeenLastCalledWith('error');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(3000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(latest().url).toBe(`${apiBaseUrl}/events?since=8`);
    stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
