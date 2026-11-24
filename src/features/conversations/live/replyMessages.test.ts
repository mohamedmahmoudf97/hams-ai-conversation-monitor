import { expect, it } from 'vitest';
import type { Message } from '../../../domain/conversation';
import type { ReplyAttempt } from './store';
import { mergeReplyMessages } from './replyMessages';

const message = (id: string): Message => ({
  id,
  conversationId: 'c-1',
  role: 'human',
  text: id,
  createdAt: '2026-11-24T12:00:00.000Z',
});
const local = (id: string, order: number, afterMessageId?: string | null): ReplyAttempt => ({
  message: message(id),
  order,
  status: 'failed',
  ...(afterMessageId !== undefined ? { afterMessageId } : {}),
});

it('keeps anchored local bubbles in their original order as canonical messages arrive', () => {
  const confirmed = [message('a'), message('b'), message('c')];
  const attempts = [local('second', 2, 'a'), local('first', 1, 'a'), local('third', 3, 'b')];
  expect(mergeReplyMessages(confirmed, attempts).map(({ id }) => id)).toEqual([
    'a',
    'first',
    'second',
    'b',
    'third',
    'c',
  ]);
  expect(confirmed.map(({ id }) => id)).toEqual(['a', 'b', 'c']);
  expect(attempts.map(({ order }) => order)).toEqual([2, 1, 3]);
});

it('distinguishes an initially empty history from absent or removed anchors', () => {
  const confirmed = [message('incoming')];
  expect(
    mergeReplyMessages(confirmed, [
      local('beginning', 1, null),
      local('fallback', 2),
      local('removed', 3, 'missing'),
    ]).map(({ id }) => id),
  ).toEqual(['beginning', 'incoming', 'fallback', 'removed']);
});

it('deduplicates local rows by server or correlation ID and preserves an unchanged canonical array', () => {
  const confirmed = [message('same-id'), { ...message('server-reply'), clientMessageId: 'attempt' }];
  const attempts = [
    local('same-id', 1),
    {
      ...local('local-reply', 2),
      message: { ...message('local-reply'), clientMessageId: 'attempt' },
    },
  ];
  expect(mergeReplyMessages(confirmed, attempts)).toBe(confirmed);
  expect(mergeReplyMessages(confirmed, [])).toBe(confirmed);
});
