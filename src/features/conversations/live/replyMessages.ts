import type { Message } from '../../../domain/conversation';
import type { ReplyAttempt } from './store';

export function mergeReplyMessages(
  confirmed: Message[],
  attempts: readonly Pick<ReplyAttempt, 'message' | 'afterMessageId' | 'order'>[],
): Message[] {
  if (!attempts.length) return confirmed;
  const ids = new Set(confirmed.map((message) => message.id));
  const correlations = new Set(confirmed.map((message) => message.clientMessageId));
  const local = attempts
    .filter(
      ({ message }) =>
        !ids.has(message.id) && !(message.clientMessageId && correlations.has(message.clientMessageId)),
    )
    .sort((a, b) => a.order - b.order);
  if (!local.length) return confirmed;

  const anchored = new Map<string | null | undefined, Message[]>();
  for (const { message, afterMessageId } of local) {
    const anchor =
      afterMessageId === null || (afterMessageId && ids.has(afterMessageId)) ? afterMessageId : undefined;
    const group = anchored.get(anchor) ?? [];
    group.push(message);
    anchored.set(anchor, group);
  }
  // Null captures an empty history; absent or removed anchors fall back to the end.
  const messages = [...(anchored.get(null) ?? [])];
  for (const message of confirmed) messages.push(message, ...(anchored.get(message.id) ?? []));
  messages.push(...(anchored.get(undefined) ?? []));
  return messages;
}
