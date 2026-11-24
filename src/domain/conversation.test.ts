import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { conversationsResponseSchema, messagesResponseSchema } from './conversation';

const conversation = {
  id: 'c-1', customer: 'نورة الشهري', status: 'needs_human',
  lastMessage: 'Can you help?', unread: 2, updatedAt: '2026-11-23T12:00:00.000Z',
};

describe('conversation response validation', () => {
  it('accepts the initial snapshot and preserves mixed-language content', () => {
    const response = { lastEventId: 0, conversations: [conversation] };
    expect(conversationsResponseSchema.parse(response)).toEqual(response);
  });

  it('accepts an empty list', () => {
    expect(conversationsResponseSchema.parse({ lastEventId: 0, conversations: [] }).conversations).toEqual([]);
  });

  it.each([null, {}, { lastEventId: 0, conversations: {} }])('rejects malformed response shapes', (value) => {
    expect(() => conversationsResponseSchema.parse(value)).toThrow(ZodError);
  });

  it('rejects invalid cursors, unread counts, and statuses', () => {
    expect(() => conversationsResponseSchema.parse({ lastEventId: '1', conversations: [] })).toThrow('lastEventId');
    expect(() => conversationsResponseSchema.parse({ lastEventId: 1, conversations: [{ ...conversation, unread: -1 }] })).toThrow('unread');
    expect(() => conversationsResponseSchema.parse({ lastEventId: 1, conversations: [{ ...conversation, status: 'waiting' }] })).toThrow('status');
  });

  it('rejects fractional and unsafe integer counts without coercing strings', () => {
    for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
      expect(() => conversationsResponseSchema.parse({ lastEventId: value, conversations: [] })).toThrow(ZodError);
      expect(() => conversationsResponseSchema.parse({ lastEventId: 0, conversations: [{ ...conversation, unread: value }] })).toThrow(ZodError);
    }
  });

  it('rejects a conversation without the expected text fields', () => {
    expect(() => conversationsResponseSchema.parse({ lastEventId: 0, conversations: [{ ...conversation, customer: null }] })).toThrow('customer');
  });
});

describe('message response validation', () => {
  const message = {
    id: 'm-1', conversationId: 'c-1', role: 'customer',
    text: 'هل يمكنني إلغاء الاشتراك Premium؟', createdAt: '2026-11-23T12:00:00.000Z',
  };

  it.each(['customer', 'ai', 'human'])('accepts a %s message and preserves its text', (role) => {
    const response = { lastEventId: 8, messages: [{ ...message, role }] };
    expect(messagesResponseSchema.parse(response)).toEqual(response);
  });

  it('accepts an empty thread and an unfinished AI snapshot', () => {
    expect(messagesResponseSchema.parse({ lastEventId: 0, messages: [] }).messages).toEqual([]);
    const response = { lastEventId: 8, messages: [{ ...message, role: 'ai', text: '', streaming: true }] };
    expect(messagesResponseSchema.parse(response)).toEqual(response);
  });

  it('preserves the server correlation ID when present', () => {
    const response = { lastEventId: 8, messages: [{ ...message, role: 'human', clientMessageId: 'reply-1' }] };
    expect(messagesResponseSchema.parse(response)).toEqual(response);
  });

  it.each([
    { lastEventId: -1, messages: [] },
    { lastEventId: 0, messages: {} },
    { lastEventId: 0, messages: [{ ...message, role: 'system' }] },
    { lastEventId: 0, messages: [{ ...message, conversationId: undefined }] },
    { lastEventId: 0, messages: [{ ...message, text: null }] },
    { lastEventId: 0, messages: [{ ...message, createdAt: 'not-a-date' }] },
    { lastEventId: 0, messages: [{ ...message, streaming: 'true' }] },
  ])('rejects malformed thread snapshots', (response) => {
    expect(() => messagesResponseSchema.parse(response)).toThrow(ZodError);
  });
});
