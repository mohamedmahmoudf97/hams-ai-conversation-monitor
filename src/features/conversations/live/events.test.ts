import { describe, expect, it } from 'vitest';
import { eventSchema } from './events';

const base = { id: 1, conversationId: 'c-1' };
const message = {
  id: 'm-1', conversationId: 'c-1', role: 'customer',
  text: 'هل يمكنني إلغاء الاشتراك Premium؟', createdAt: '2026-11-23T12:00:00.000Z',
};

describe('live event validation', () => {
  it.each([
    { ...base, type: 'message_start', messageId: 'm-2', role: 'ai' },
    { ...base, type: 'token', messageId: 'm-2', text: ' شكراً' },
    { ...base, type: 'message_end', messageId: 'm-2' },
    { ...base, type: 'message', message },
    { ...base, type: 'status', status: 'needs_human' },
    { ...base, type: 'tool_call', name: 'transfer_to_human', args: { reason: 'Billing dispute' } },
  ])('accepts the mock $type contract without inventing missing fields', (event) => {
    expect(eventSchema.parse(event)).toEqual(event);
  });

  it.each([
    null,
    { ...base, type: 'unknown' },
    { ...base, id: 0, type: 'status', status: 'ai' },
    { ...base, id: Number.MAX_SAFE_INTEGER + 1, type: 'status', status: 'ai' },
    { ...base, type: 'token', messageId: 'm-1', text: null },
    { ...base, type: 'status', status: 'waiting' },
    { ...base, type: 'message', message: { ...message, conversationId: 'c-2' } },
    { ...base, type: 'tool_call', name: 'transfer_to_human', args: {} },
  ])('rejects malformed or inconsistent events', (event) => {
    expect(eventSchema.safeParse(event).success).toBe(false);
  });
});
