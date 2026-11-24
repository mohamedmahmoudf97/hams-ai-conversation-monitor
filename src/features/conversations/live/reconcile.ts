import type { ConversationsResponse, Message, MessagesResponse } from '../../../domain/conversation';
import type { LiveEvent } from './events';

export type ReceivedEvent = { event: LiveEvent; receivedAt: string; endText?: string };
export type SnapshotUpdate = ReceivedEvent | { message: Message };

const sameMessage = (a: Message, b: Message) =>
  a.id === b.id || Boolean(a.clientMessageId && a.clientMessageId === b.clientMessageId);

function moveToFront(conversations: ConversationsResponse['conversations'], id: string) {
  const updated = conversations.find((conversation) => conversation.id === id);
  return updated
    ? [updated, ...conversations.filter((conversation) => conversation.id !== id)]
    : conversations;
}

export function upsertMessage(messages: Message[], confirmed: Message): Message[] {
  const matches = (message: Message) => sameMessage(message, confirmed);
  const index = messages.findIndex(matches);
  if (index === -1) return [...messages, confirmed];
  return messages.flatMap((message, i) => (matches(message) ? (i === index ? [confirmed] : []) : [message]));
}

export function applyReplyPreview(data: ConversationsResponse, message: Message): ConversationsResponse {
  return {
    ...data,
    conversations: moveToFront(
      data.conversations.map((conversation) =>
        conversation.id === message.conversationId
          ? { ...conversation, lastMessage: message.text, updatedAt: message.createdAt }
          : conversation,
      ),
      message.conversationId,
    ),
  };
}

export function applyMessageEvent(
  messages: Message[],
  { event, receivedAt, endText }: ReceivedEvent,
  pendingIds: ReadonlySet<string> = new Set(),
): Message[] {
  if (event.type === 'status' || event.type === 'tool_call') return messages;
  // SSE order is authoritative. POST-only rows wait at the tail until their echo arrives.
  const insert = (message: Message, rows = messages) => {
    const index = rows.findIndex((row) => pendingIds.has(row.id));
    const position = index === -1 ? rows.length : index;
    return [...rows.slice(0, position), message, ...rows.slice(position)];
  };
  if (event.type === 'message') {
    const current = messages.find((message) => sameMessage(message, event.message));
    if (current && !pendingIds.has(current.id)) return upsertMessage(messages, event.message);
    return insert(
      event.message,
      messages.filter((message) => !sameMessage(message, event.message)),
    );
  }
  const id = event.messageId;
  const index = messages.findIndex((message) => message.id === id);
  const current = messages[index];
  let next: Message;
  if (event.type === 'message_start') {
    if (current) return messages;
    next = {
      id,
      conversationId: event.conversationId,
      role: event.role,
      text: '',
      createdAt: receivedAt,
      streaming: true,
    };
  } else {
    if (!current) return messages;
    next =
      event.type === 'token'
        ? { ...current, text: current.text + event.text, streaming: true }
        : { ...current, text: endText ?? current.text, streaming: false };
  }
  if (index === -1) return insert(next);
  const result = messages.slice();
  result[index] = next;
  return result;
}

export function applyConversationEvent(
  data: ConversationsResponse,
  entry: ReceivedEvent,
  pendingPreview?: Message,
): ConversationsResponse {
  const { event, receivedAt, endText } = entry;
  if (event.type === 'token') return data;
  const conversations = data.conversations.map((conversation) => {
    if (conversation.id !== event.conversationId) return conversation;
    if (event.type === 'status' || event.type === 'tool_call')
      return {
        ...conversation,
        status: event.type === 'status' ? event.status : ('needs_human' as const),
        updatedAt: receivedAt,
      };
    if (event.type === 'message')
      return {
        ...conversation,
        lastMessage: pendingPreview ? conversation.lastMessage : event.message.text,
        unread: conversation.unread + (event.message.role === 'customer' ? 1 : 0),
        updatedAt: event.message.createdAt,
      };
    if (event.type === 'message_end' && endText !== undefined)
      return {
        ...conversation,
        lastMessage: pendingPreview ? conversation.lastMessage : endText,
        updatedAt: receivedAt,
      };
    if (event.type === 'message_start') return { ...conversation, updatedAt: receivedAt };
    return conversation;
  });
  return {
    lastEventId: Math.max(data.lastEventId, event.id),
    conversations: moveToFront(conversations, event.conversationId),
  };
}

export function reconcileMessages(
  snapshot: MessagesResponse,
  buffered: SnapshotUpdate[],
  pendingIds: ReadonlySet<string> = new Set(),
): MessagesResponse {
  let messages = snapshot.messages;
  let lastEventId = snapshot.lastEventId;
  const pending = new Set(pendingIds);
  for (const message of messages) pending.delete(message.id);
  for (const entry of buffered) {
    if (!('event' in entry)) {
      if (!messages.some((message) => sameMessage(message, entry.message))) {
        messages = [...messages, entry.message];
        pending.add(entry.message.id);
      }
      continue;
    }
    if (entry.event.id <= snapshot.lastEventId) continue;
    // Snapshot text plus later tokens is authoritative; an older overlay may lack the prefix.
    messages = applyMessageEvent(messages, { event: entry.event, receivedAt: entry.receivedAt }, pending);
    if (entry.event.type === 'message') pending.delete(entry.event.message.id);
    lastEventId = Math.max(lastEventId, entry.event.id);
  }
  return { messages, lastEventId };
}

export function reconcileConversations(
  snapshot: ConversationsResponse,
  updates: SnapshotUpdate[],
  pendingPreviews: ReadonlyMap<string, Message>,
) {
  const pending = new Map(pendingPreviews);
  let data = snapshot;
  const covered = (message: Message) => {
    const echo = updates.find(
      (update) =>
        'event' in update && update.event.type === 'message' && sameMessage(update.event.message, message),
    );
    // Compare server timestamps only against the untouched snapshot, never receipt-time estimates.
    return echo && 'event' in echo
      ? echo.event.id <= snapshot.lastEventId
      : snapshot.conversations.some(
          (conversation) =>
            conversation.id === message.conversationId && conversation.updatedAt >= message.createdAt,
        );
  };
  for (const message of pending.values()) {
    if (covered(message)) pending.delete(message.conversationId);
    else data = applyReplyPreview(data, message);
  }
  for (const update of updates) {
    if (!('event' in update)) {
      if (!covered(update.message)) {
        pending.set(update.message.conversationId, update.message);
        data = applyReplyPreview(data, update.message);
      }
      continue;
    }
    const { event } = update;
    if (event.type === 'message' && pending.get(event.conversationId)?.id === event.message.id)
      pending.delete(event.conversationId);
    if (event.id > snapshot.lastEventId)
      data = applyConversationEvent(data, update, pending.get(event.conversationId));
  }
  return { data, pendingPreviews: pending };
}
