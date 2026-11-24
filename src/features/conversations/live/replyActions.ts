import type { QueryClient } from '@tanstack/react-query';
import { ApiError, sendMessage } from '../../../api/client';
import type { ConversationsResponse, Message, MessagesResponse } from '../../../domain/conversation';
import type { createLiveStore, ReplyAttempt } from './store';

type Options = {
  queryClient: QueryClient;
  store: ReturnType<typeof createLiveStore>;
  getEpoch: () => number;
  loadMessages: (id: string, signal?: AbortSignal) => Promise<MessagesResponse>;
  confirmReply: (message: Message) => void;
};

export function createReplyActions({ queryClient, store, getEpoch, loadMessages, confirmReply }: Options) {
  let replyOrder = 0;
  function setDraft(id: string, text: string) {
    store.setState((state) => ({ drafts: { ...state.drafts, [id]: text } }));
  }

  async function checkDelivery(id: string) {
    const attempt = store.getState().sends[id];
    if (!attempt || attempt.status !== 'uncertain' || attempt.checking) return;
    const isCurrent = () =>
      store.getState().sends[id]?.message.clientMessageId === attempt.message.clientMessageId;
    store.setState((state) => ({ sends: { ...state.sends, [id]: { ...attempt, checking: true } } }));
    try {
      await queryClient.fetchQuery({
        queryKey: ['messages', id],
        queryFn: ({ signal }) => loadMessages(id, signal),
        staleTime: 0,
      });
    } catch {
      if (isCurrent())
        store.setState((state) => ({
          sends: {
            ...state.sends,
            [id]: {
              ...state.sends[id]!,
              error: 'Could not check delivery. Try checking again before resending.',
            },
          },
        }));
    } finally {
      if (isCurrent())
        store.setState((state) => ({
          sends: { ...state.sends, [id]: { ...state.sends[id]!, checking: false } },
        }));
    }
  }

  async function postReply(id: string, text: string, retry?: ReplyAttempt) {
    text = text.trim();
    const status = queryClient
      .getQueryData<ConversationsResponse>(['conversations'])
      ?.conversations.find((conversation) => conversation.id === id)?.status;
    const active = store.getState().sends[id];
    if (
      !text ||
      status !== 'human' ||
      active?.status === 'sending' ||
      active?.checking ||
      (active?.status === 'uncertain' && retry?.message.id !== active.message.id)
    )
      return;
    const requestEpoch = getEpoch();
    const clientMessageId = crypto.randomUUID();
    const message: Message = retry
      ? { ...retry.message, clientMessageId }
      : {
          id: `pending-${clientMessageId}`,
          conversationId: id,
          role: 'human',
          text,
          createdAt: new Date().toISOString(),
          clientMessageId,
        };
    const attempt: ReplyAttempt = {
      ...(retry
        ? {
            order: retry.order,
            ...(retry.afterMessageId !== undefined ? { afterMessageId: retry.afterMessageId } : {}),
          }
        : {
            afterMessageId:
              queryClient.getQueryData<MessagesResponse>(['messages', id])?.messages.at(-1)?.id ?? null,
            order: ++replyOrder,
          }),
      message,
      status: 'sending',
    };
    store.setState((state) => {
      const archived = state.failedReplies[id] ?? [];
      const remaining = archived.some((item) => item.message.id === message.id)
        ? archived.filter((item) => item.message.id !== message.id)
        : archived;
      const failed =
        active?.status === 'failed' && active.message.id !== message.id ? [...remaining, active] : remaining;
      return {
        drafts: retry
          ? state.drafts
          : {
              ...state.drafts,
              [id]: state.drafts[id]?.trim() === text ? '' : (state.drafts[id] ?? ''),
            },
        failedReplies: failed === archived ? state.failedReplies : { ...state.failedReplies, [id]: failed },
        sends: { ...state.sends, [id]: attempt },
      };
    });
    try {
      const confirmed = await sendMessage(id, { text, clientMessageId });
      if (getEpoch() === requestEpoch) confirmReply(confirmed);
    } catch (error) {
      if (
        getEpoch() !== requestEpoch ||
        store.getState().sends[id]?.message.clientMessageId !== clientMessageId
      )
        return;
      const rejected = error instanceof ApiError && [400, 409, 500].includes(error.status);
      store.setState((state) => ({
        sends: {
          ...state.sends,
          [id]: {
            ...attempt,
            status: rejected ? 'failed' : 'uncertain',
            error: rejected
              ? error.message
              : 'Delivery is unconfirmed. Sending again may create a duplicate reply.',
          },
        },
      }));
      if (error instanceof ApiError && error.status === 409)
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (!rejected) await checkDelivery(id);
    }
  }

  return {
    setDraft,
    checkDelivery,
    async sendReply(id: string) {
      if (store.getState().sends[id]?.status === 'uncertain') return;
      await postReply(id, store.getState().drafts[id] ?? '');
    },
    async retryReply(id: string, messageId: string) {
      const active = store.getState().sends[id];
      const attempt =
        active?.message.id === messageId
          ? active
          : store.getState().failedReplies[id]?.find((item) => item.message.id === messageId);
      if (attempt && attempt.status !== 'sending' && !attempt.checking)
        await postReply(id, attempt.message.text, attempt);
    },
  };
}
