import {
  conversationsResponseSchema,
  messagesResponseSchema,
  sendMessageResponseSchema,
  takeoverResponseSchema,
} from '../domain/conversation';
import type { Conversation, ConversationsResponse, Message, MessagesResponse } from '../domain/conversation';
import { apiBaseUrl } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request(path: string, options: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiBaseUrl}${path}`, options);

  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `Request failed (HTTP ${response.status}).`;
    throw new ApiError(response.status, message);
  }

  return response.json();
}

export async function getConversations(signal?: AbortSignal): Promise<ConversationsResponse> {
  return conversationsResponseSchema.parse(await request('/conversations', { signal: signal ?? null }));
}

export async function getMessages(conversationId: string, signal?: AbortSignal): Promise<MessagesResponse> {
  return messagesResponseSchema.parse(
    await request(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
      signal: signal ?? null,
    }),
  );
}

export async function takeOverConversation(conversationId: string): Promise<Conversation> {
  const response = await request(`/conversations/${encodeURIComponent(conversationId)}/takeover`, {
    method: 'POST',
  });
  return takeoverResponseSchema
    .refine(
      ({ conversation }) => conversation.id === conversationId,
      'Takeover response does not match the requested conversation.',
    )
    .parse(response).conversation;
}

export async function sendMessage(
  conversationId: string,
  reply: { text: string; clientMessageId: string },
): Promise<Message> {
  const response = await request(`/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reply),
  });
  return sendMessageResponseSchema
    .refine(
      ({ message }) =>
        message.conversationId === conversationId && message.clientMessageId === reply.clientMessageId,
      'Reply confirmation does not match the sent message.',
    )
    .parse(response).message;
}
