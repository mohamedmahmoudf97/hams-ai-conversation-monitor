import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { ApiError, getConversations, getMessages, sendMessage, takeOverConversation } from './client';
import { apiBaseUrl } from './config';

const fetcher = vi.fn<typeof fetch>();
beforeEach(() => vi.stubGlobal('fetch', fetcher));
afterEach(() => vi.unstubAllGlobals());

describe('conversation request', () => {
  it('fetches a validated snapshot and passes the cancellation signal', async () => {
    fetcher.mockResolvedValue(Response.json({ lastEventId: 12, conversations: [] }));
    const signal = new AbortController().signal;
    await expect(getConversations(signal)).resolves.toEqual({ lastEventId: 12, conversations: [] });
    expect(fetcher).toHaveBeenCalledWith(`${apiBaseUrl}/conversations`, { signal });
  });

  it('rejects malformed successful responses', async () => {
    fetcher.mockResolvedValue(Response.json({ conversations: [] }));
    await expect(getConversations()).rejects.toThrow('lastEventId');
  });

  it('shows the server error message', async () => {
    fetcher.mockResolvedValue(Response.json({ error: 'Service unavailable' }, { status: 503 }));
    await expect(getConversations()).rejects.toThrow('Service unavailable');
  });

  it('gives a useful error when the response is not JSON', async () => {
    fetcher.mockResolvedValue(new Response('Unavailable', { status: 502 }));
    await expect(getConversations()).rejects.toThrow('HTTP 502');
  });

  it('passes a network failure back to the UI without retrying', async () => {
    const failure = new TypeError('Failed to fetch');
    fetcher.mockRejectedValue(failure);
    await expect(getConversations()).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('takeover request', () => {
  const conversation = {
    id: 'c/1',
    customer: 'محمد',
    status: 'human',
    lastMessage: 'Hello',
    unread: 2,
    updatedAt: '2026-11-23T12:00:00.000Z',
  };

  it('posts to the selected conversation and returns validated human status', async () => {
    fetcher.mockResolvedValue(Response.json({ conversation }));
    await expect(takeOverConversation('c/1')).resolves.toEqual(conversation);
    expect(fetcher).toHaveBeenCalledWith(`${apiBaseUrl}/conversations/c%2F1/takeover`, { method: 'POST' });
  });

  it('preserves a closed-conversation conflict for the UI', async () => {
    fetcher.mockResolvedValue(Response.json({ error: 'Conversation is closed' }, { status: 409 }));
    await expect(takeOverConversation('c/1')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Conversation is closed',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { conversation: { ...conversation, id: 'another-conversation' } },
    { conversation: { ...conversation, status: 'needs_human' } },
  ])('does not enable human mode from a malformed confirmation', async (response) => {
    fetcher.mockResolvedValue(Response.json(response));
    await expect(takeOverConversation('c/1')).rejects.toBeInstanceOf(ZodError);
  });
});

describe('reply request', () => {
  const reply = { text: 'مرحباً Premium', clientMessageId: 'local-1' };
  const message = {
    id: 'm-1',
    conversationId: 'c/1',
    role: 'human',
    ...reply,
    createdAt: '2026-11-23T12:00:00.000Z',
  };

  it('posts JSON with the correlation ID and returns the server message', async () => {
    fetcher.mockResolvedValue(Response.json({ message }, { status: 201 }));
    await expect(sendMessage('c/1', reply)).resolves.toEqual(message);
    expect(fetcher).toHaveBeenCalledWith(`${apiBaseUrl}/conversations/c%2F1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reply),
    });
  });

  it.each([400, 409, 500])('retains HTTP %s as a definite rejection without retrying', async (status) => {
    fetcher.mockResolvedValue(Response.json({ error: 'Reply rejected' }, { status }));
    const failure = await sendMessage('c/1', reply).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status, message: 'Reply rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retains the HTTP status even when the failure body is not JSON', async () => {
    fetcher.mockResolvedValue(new Response('Unavailable', { status: 503 }));
    await expect(sendMessage('c/1', reply)).rejects.toMatchObject({
      status: 503,
      message: 'Request failed (HTTP 503).',
    });
  });

  it('leaves network failure uncertain and never resends automatically', async () => {
    const failure = new TypeError('Failed to fetch');
    fetcher.mockRejectedValue(failure);
    await expect(sendMessage('c/1', reply)).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { message: { ...message, role: 'ai' } },
    { message: { ...message, conversationId: 'another-conversation' } },
    { message: { ...message, clientMessageId: 'another-attempt' } },
    { message: { ...message, clientMessageId: undefined } },
  ])('leaves a malformed success uncertain instead of accepting the wrong reply', async (response) => {
    fetcher.mockResolvedValue(Response.json(response, { status: 201 }));
    await expect(sendMessage('c/1', reply)).rejects.toBeInstanceOf(ZodError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('message request', () => {
  it('encodes the selected ID, passes cancellation, and validates the snapshot', async () => {
    const response = {
      lastEventId: 12,
      messages: [
        {
          id: 'm-1',
          conversationId: 'c/1',
          role: 'ai',
          text: 'Hello',
          createdAt: '2026-11-23T12:00:00.000Z',
        },
      ],
    };
    fetcher.mockResolvedValue(Response.json(response));
    const signal = new AbortController().signal;
    await expect(getMessages('c/1', signal)).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledWith(`${apiBaseUrl}/conversations/c%2F1/messages`, { signal });
  });

  it('rejects a malformed successful thread response', async () => {
    fetcher.mockResolvedValue(Response.json({ lastEventId: 12, messages: [{ text: 'Incomplete' }] }));
    await expect(getMessages('c-1')).rejects.toThrow('conversationId');
  });

  it('surfaces a missing conversation error', async () => {
    fetcher.mockResolvedValue(Response.json({ error: 'Conversation not found' }, { status: 404 }));
    await expect(getMessages('missing')).rejects.toThrow('Conversation not found');
  });

  it('preserves an abort instead of retrying the cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    fetcher.mockRejectedValue(controller.signal.reason);
    await expect(getMessages('c-1', controller.signal)).rejects.toBe(controller.signal.reason);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
