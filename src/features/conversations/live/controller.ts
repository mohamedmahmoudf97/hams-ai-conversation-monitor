import { isCancelledError, type QueryClient } from '@tanstack/react-query';
import { ApiError, getConversations, getMessages, takeOverConversation } from '../../../api/client';
import type {
  Conversation,
  ConversationsResponse,
  Message,
  MessagesResponse,
} from '../../../domain/conversation';
import { connectEvents } from './connection';
import type { LiveEvent } from './events';
import {
  applyConversationEvent,
  applyMessageEvent,
  applyReplyPreview,
  reconcileConversations,
  reconcileMessages,
  upsertMessage,
} from './reconcile';
import type { ReceivedEvent, SnapshotUpdate } from './reconcile';
import { createLiveStore } from './store';
import { createReplyActions } from './replyActions';

type PendingSnapshot = {
  updates: SnapshotUpdate[];
  pendingMessageIds: Set<string>;
  pendingPreviews: Map<string, Message>;
  takeovers: Conversation[];
  epoch: number;
  cursor: number;
};
const messagesKey = (id: string) => ['messages', id] as const;
const aborted = () => new DOMException('Request was superseded.', 'AbortError');

export function createConversationLive(queryClient: QueryClient) {
  const store = createLiveStore();
  let cursor: number | undefined;
  let listWatermark = 0;
  const threadWatermarks = new Map<string, number>();
  const statusRevisions = new Map<string, number>();
  const pendingMessageIds = new Set<string>();
  let pendingPreviews = new Map<string, Message>();
  let listPending: PendingSnapshot | undefined;
  const threadsPending = new Map<string, PendingSnapshot>();
  const recovering = new Set<string>();
  let epoch = 0;
  let running = false;
  let disconnect: (() => void) | undefined;
  let checkingRestart = false;

  const pendingSnapshot = (): PendingSnapshot => ({
    updates: [],
    pendingMessageIds: new Set(pendingMessageIds),
    pendingPreviews: new Map(pendingPreviews),
    takeovers: [],
    epoch,
    cursor: cursor ?? 0,
  });
  const conversation = (id: string) =>
    queryClient
      .getQueryData<ConversationsResponse>(['conversations'])
      ?.conversations.find((item) => item.id === id);

  function acknowledge(message: Message) {
    const id = message.conversationId;
    if (
      !message.clientMessageId ||
      store.getState().sends[id]?.message.clientMessageId !== message.clientMessageId
    )
      return;
    store.setState((state) => {
      const sends = { ...state.sends };
      delete sends[id];
      return { sends };
    });
  }

  function confirmReply(message: Message) {
    // SSE or a snapshot may have acknowledged this attempt before its POST returns.
    if (store.getState().sends[message.conversationId]?.message.clientMessageId !== message.clientMessageId)
      return;
    const cached = queryClient.getQueryData<MessagesResponse>(messagesKey(message.conversationId));
    const known = cached?.messages.some(
      (row) =>
        row.id === message.id ||
        Boolean(row.clientMessageId && row.clientMessageId === message.clientMessageId),
    );
    if (!known) {
      pendingMessageIds.add(message.id);
      pendingPreviews.set(message.conversationId, message);
      threadsPending.get(message.conversationId)?.updates.push({ message });
      listPending?.updates.push({ message });
      queryClient.setQueryData<ConversationsResponse>(
        ['conversations'],
        (data) => data && applyReplyPreview(data, message),
      );
    }
    queryClient.setQueryData<MessagesResponse>(
      messagesKey(message.conversationId),
      (data) => data && { ...data, messages: upsertMessage(data.messages, message) },
    );
    acknowledge(message);
  }

  function connect() {
    if (!running || cursor === undefined || disconnect) return;
    disconnect = connectEvents({
      getCursor: () => cursor ?? 0,
      onEvent: receive,
      onStatus: (connection) => store.setState({ connection }),
    });
  }

  function setStream(id: string, message: Message | undefined) {
    store.setState((state) => {
      const streams = { ...state.streams };
      if (message) streams[id] = message;
      else delete streams[id];
      return { streams };
    });
  }

  // A lower counter at request time means the mock was restarted, not ordinary replay.
  function reset(nextCursor: number) {
    disconnect?.();
    disconnect = undefined;
    epoch++;
    cursor = nextCursor;
    listWatermark = nextCursor;
    threadWatermarks.clear();
    statusRevisions.clear();
    pendingMessageIds.clear();
    pendingPreviews.clear();
    threadsPending.clear();
    store.setState((state) => ({
      connection: 'connecting',
      streams: {},
      handoffs: {},
      takeovers: {},
      sends: Object.fromEntries(
        Object.entries(state.sends).map(([id, attempt]) => [
          id,
          {
            ...attempt,
            status: 'failed' as const,
            checking: false,
            error: 'The server restarted. Review and retry your reply.',
          },
        ]),
      ),
    }));
    void queryClient.resetQueries({ queryKey: ['messages'] });
    connect();
  }

  async function loadConversations(signal?: AbortSignal): Promise<ConversationsResponse> {
    const pending = pendingSnapshot();
    listPending = pending;
    try {
      let data = await getConversations(signal);
      if (signal?.aborted || listPending !== pending || pending.epoch !== epoch) throw aborted();
      if (data.lastEventId < pending.cursor) {
        pending.updates = [];
        pending.pendingMessageIds.clear();
        pending.pendingPreviews.clear();
        pending.takeovers = [];
        reset(data.lastEventId);
      }
      const reconciled = reconcileConversations(data, pending.updates, pending.pendingPreviews);
      data = reconciled.data;
      pendingPreviews = reconciled.pendingPreviews;
      for (const takeover of pending.takeovers) {
        data = {
          ...data,
          conversations: data.conversations.map((item) =>
            item.id === takeover.id && item.updatedAt <= takeover.updatedAt
              ? { ...item, status: takeover.status }
              : item,
          ),
        };
      }
      for (const item of data.conversations) {
        if (conversation(item.id)?.status !== item.status)
          statusRevisions.set(item.id, (statusRevisions.get(item.id) ?? 0) + 1);
      }
      listWatermark = Math.max(
        data.lastEventId,
        ...pending.updates.map((update) => ('event' in update ? update.event.id : 0)),
      );
      // Only the first list snapshot bootstraps the transport cursor.
      if (cursor === undefined) cursor = data.lastEventId;
      connect();
      return data;
    } finally {
      if (listPending === pending) listPending = undefined;
    }
  }

  async function loadMessages(id: string, signal?: AbortSignal): Promise<MessagesResponse> {
    const pending = pendingSnapshot();
    threadsPending.set(id, pending);
    try {
      const snapshot = await getMessages(id, signal);
      if (signal?.aborted || threadsPending.get(id) !== pending || pending.epoch !== epoch) throw aborted();
      if (snapshot.lastEventId < pending.cursor) {
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        throw new Error('The server restarted. Reload the inbox to reconnect.');
      }
      const data = reconcileMessages(snapshot, pending.updates, pending.pendingMessageIds);
      for (const message of snapshot.messages) pendingMessageIds.delete(message.id);
      const attempt = store.getState().sends[id];
      const confirmed =
        attempt &&
        data.messages.find((message) => message.clientMessageId === attempt.message.clientMessageId);
      if (confirmed) {
        // Install the server row before removing the local row from the live store.
        queryClient.setQueryData(messagesKey(id), data);
        acknowledge(confirmed);
      }
      threadWatermarks.set(id, data.lastEventId);
      setStream(id, data.messages.filter((message) => message.streaming).at(-1));
      if (
        pending.updates.some(
          (update) =>
            'event' in update && update.event.type === 'message_end' && update.endText === undefined,
        )
      ) {
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      }
      return data;
    } finally {
      if (threadsPending.get(id) === pending) threadsPending.delete(id);
    }
  }

  function recoverThread(id: string) {
    if (!running || threadsPending.has(id) || recovering.has(id)) return;
    const recoveryEpoch = epoch;
    recovering.add(id);
    void queryClient.invalidateQueries({ queryKey: messagesKey(id), exact: true, refetchType: 'none' });
    void queryClient
      .fetchQuery({
        queryKey: messagesKey(id),
        queryFn: ({ signal }) => loadMessages(id, signal),
        staleTime: 0,
      })
      .then(() => {
        // A missed end frame has no final text; recover the server's inbox preview too.
        if (running && epoch === recoveryEpoch)
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      })
      .catch((error: unknown) => {
        const cancelled = isCancelledError(error) || (error instanceof Error && error.name === 'AbortError');
        if (running && epoch === recoveryEpoch && !cancelled) store.setState({ connection: 'error' });
      })
      .finally(() => recovering.delete(id));
  }

  function receive(event: LiveEvent) {
    if (!running || cursor === undefined) return;
    if (event.id <= cursor) {
      // Normal overlap is at most three frames. Confirm a larger rewind with REST.
      if (event.id < cursor - 3 && !checkingRestart) {
        checkingRestart = true;
        void queryClient
          .fetchQuery({
            queryKey: ['conversations'],
            queryFn: ({ signal }) => loadConversations(signal),
            staleTime: 0,
          })
          .catch(() => store.setState({ connection: 'error' }))
          .finally(() => {
            checkingRestart = false;
          });
      }
      return;
    }
    const id = event.conversationId;
    const stream = store.getState().streams[id];
    const cached = queryClient.getQueryData<MessagesResponse>(messagesKey(id));
    const entry: ReceivedEvent = { event, receivedAt: new Date().toISOString() };
    if (event.type === 'message_end') {
      if (stream?.id === event.messageId) entry.endText = stream.text;
      else if (event.id <= (threadWatermarks.get(id) ?? 0)) {
        const completed = cached?.messages.find(
          (message) => message.id === event.messageId && !message.streaming,
        );
        if (completed) entry.endText = completed.text;
      }
    }
    listPending?.updates.push(entry);
    threadsPending.get(id)?.updates.push(entry);
    if (event.type === 'message' && pendingPreviews.get(id)?.id === event.message.id)
      pendingPreviews.delete(id);

    if (event.type === 'tool_call') {
      store.setState((state) => ({ handoffs: { ...state.handoffs, [id]: event.args.reason } }));
    }
    if (event.id > listWatermark) {
      if (event.type === 'status' || event.type === 'tool_call')
        statusRevisions.set(id, (statusRevisions.get(id) ?? 0) + 1);
      if (event.type !== 'token') {
        queryClient.setQueryData<ConversationsResponse>(
          ['conversations'],
          (data) => data && applyConversationEvent(data, entry, pendingPreviews.get(id)),
        );
      }
      listWatermark = event.id;
    }
    if (event.id > (threadWatermarks.get(id) ?? 0)) {
      if (event.type === 'message_start') {
        const message = applyMessageEvent([], entry)[0]!;
        setStream(id, message);
        if (cached)
          queryClient.setQueryData(messagesKey(id), {
            ...cached,
            messages: applyMessageEvent(cached.messages, entry, pendingMessageIds),
          });
      } else if (event.type === 'token') {
        const current =
          stream?.id === event.messageId
            ? stream
            : cached?.messages.find((message) => message.id === event.messageId);
        if (current) setStream(id, { ...current, text: current.text + event.text, streaming: true });
        else recoverThread(id);
      } else if (event.type === 'message_end') {
        if (
          cached &&
          (entry.endText !== undefined || cached.messages.some((message) => message.id === event.messageId))
        ) {
          queryClient.setQueryData(messagesKey(id), {
            ...cached,
            messages: applyMessageEvent(cached.messages, entry),
          });
        } else if (entry.endText === undefined) recoverThread(id);
        if (stream?.id === event.messageId) setStream(id, undefined);
      } else if (event.type === 'message' && cached) {
        queryClient.setQueryData(messagesKey(id), {
          ...cached,
          messages: applyMessageEvent(cached.messages, entry, pendingMessageIds),
        });
      }
      threadWatermarks.set(id, event.id);
    }
    if (event.type === 'message') {
      pendingMessageIds.delete(event.message.id);
      acknowledge(event.message);
    }
    cursor = event.id;
  }

  async function takeOver(id: string) {
    if (conversation(id)?.status !== 'needs_human' || store.getState().takeovers[id]?.pending) return;
    const revision = statusRevisions.get(id) ?? 0;
    const requestEpoch = epoch;
    store.setState((state) => ({ takeovers: { ...state.takeovers, [id]: { pending: true } } }));
    try {
      const result = await takeOverConversation(id);
      if (epoch !== requestEpoch) return;
      if ((statusRevisions.get(id) ?? 0) === revision) {
        listPending?.takeovers.push(result);
        queryClient.setQueryData<ConversationsResponse>(
          ['conversations'],
          (data) =>
            data && {
              ...data,
              conversations: data.conversations.map((item) =>
                item.id === id ? { ...item, status: result.status } : item,
              ),
            },
        );
      }
      store.setState((state) => ({ takeovers: { ...state.takeovers, [id]: { pending: false } } }));
    } catch (error) {
      if (epoch !== requestEpoch) return;
      store.setState((state) => ({
        takeovers: {
          ...state.takeovers,
          [id]: {
            pending: false,
            error:
              error instanceof ApiError
                ? error.message
                : 'Could not confirm takeover. Check the conversation and try again.',
          },
        },
      }));
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }
  }

  return {
    store,
    loadConversations,
    loadMessages,
    takeOver,
    ...createReplyActions({ queryClient, store, getEpoch: () => epoch, loadMessages, confirmReply }),
    start() {
      running = true;
      connect();
    },
    stop() {
      running = false;
      disconnect?.();
      disconnect = undefined;
      for (const id of recovering) void queryClient.cancelQueries({ queryKey: messagesKey(id), exact: true });
    },
  };
}
