import { describe, expect, it } from 'vitest';
import type { Message } from '../../../domain/conversation';
import { applyConversationEvent, applyMessageEvent, reconcileMessages, upsertMessage } from './reconcile';
import type { ReceivedEvent } from './reconcile';

const receivedAt = '2026-11-23T12:00:00.000Z';
const message: Message = {
  id: 'm-1',
  conversationId: 'c-1',
  role: 'ai',
  text: 'Hello ',
  createdAt: receivedAt,
  streaming: true,
};
const entry = (event: ReceivedEvent['event']): ReceivedEvent => ({ event, receivedAt });

describe('snapshot reconciliation', () => {
  it('appends a POST confirmation and replaces it in place by its correlation ID', () => {
    const later = { ...message, id: 'later', createdAt: '2026-11-23T12:00:02.000Z' };
    const confirmed = { ...message, id: 'reply', clientMessageId: 'attempt-1', streaming: false };
    const result = [...upsertMessage([], confirmed), later];
    expect(result.map(({ id }) => id)).toEqual(['reply', 'later']);
    expect(upsertMessage(result, { ...confirmed, id: 'server-reply' }).map(({ id }) => id)).toEqual([
      'server-reply',
      'later',
    ]);
  });

  it('uses the snapshot prefix and applies only subsequent tokens', () => {
    const result = reconcileMessages({ lastEventId: 12, messages: [message] }, [
      entry({ id: 12, conversationId: 'c-1', type: 'token', messageId: 'm-1', text: 'Hello ' }),
      entry({ id: 13, conversationId: 'c-1', type: 'token', messageId: 'm-1', text: 'world' }),
      entry({ id: 14, conversationId: 'c-1', type: 'message_end', messageId: 'm-1' }),
    ]);
    expect(result).toMatchObject({ lastEventId: 14, messages: [{ text: 'Hello world', streaming: false }] });
    expect(message.text).toBe('Hello ');
  });

  it('does not replace existing text when a start is replayed', () => {
    const messages = [message];
    expect(
      applyMessageEvent(
        messages,
        entry({ id: 12, conversationId: 'c-1', type: 'message_start', messageId: 'm-1', role: 'ai' }),
      ),
    ).toBe(messages);
  });

  it('does not let a stale live overlay overwrite an authoritative snapshot prefix', () => {
    const result = reconcileMessages({ lastEventId: 12, messages: [message] }, [
      entry({ id: 13, conversationId: 'c-1', type: 'token', messageId: 'm-1', text: 'world' }),
      {
        ...entry({ id: 14, conversationId: 'c-1', type: 'message_end', messageId: 'm-1' }),
        endText: 'world',
      },
    ]);
    expect(result.messages[0]).toMatchObject({ text: 'Hello world', streaming: false });
  });

  it('uses the accumulated live text to finalize a cache stub', () => {
    const completed = applyMessageEvent([{ ...message, text: '' }], {
      ...entry({ id: 14, conversationId: 'c-1', type: 'message_end', messageId: 'm-1' }),
      endText: 'Hello world',
    });
    expect(completed[0]).toMatchObject({ text: 'Hello world', streaming: false });
  });

  it('replaces matching message IDs without appending duplicates', () => {
    const confirmed = { ...message, text: 'Confirmed', streaming: false };
    expect(
      applyMessageEvent(
        [message],
        entry({ id: 14, conversationId: 'c-1', type: 'message', message: confirmed }),
      ),
    ).toEqual([confirmed]);
  });

  it('retains unaffected message references when one message changes', () => {
    const other = { ...message, id: 'other' };
    const result = applyMessageEvent(
      [other, message],
      entry({ id: 13, conversationId: 'c-1', type: 'token', messageId: 'm-1', text: 'world' }),
    );
    expect(result[0]).toBe(other);
    expect(result[1]).not.toBe(message);
  });

  it('does not mutate inbox previews or ordering for token events', () => {
    const snapshot = { lastEventId: 12, conversations: [] };
    expect(
      applyConversationEvent(
        snapshot,
        entry({ id: 13, conversationId: 'c-1', type: 'token', messageId: 'm-1', text: 'world' }),
      ),
    ).toBe(snapshot);
  });
});
