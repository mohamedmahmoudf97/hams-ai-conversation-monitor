import { memo, useMemo } from 'react';
import { Avatar, Button, Card, Surface, Tooltip, Typography } from '@heroui/react';
import { ArrowClockwiseIcon, LockSimpleIcon, UserIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { useConversationLive } from '../live/LiveProvider';
import { mergeReplyMessages } from '../live/replyMessages';
import { HandoffNotice } from './HandoffNotice';
import type { Conversation } from '../../../domain/conversation';
import { useTranslation } from '../../../i18n/useTranslation';
import { MessageList } from './MessageList';
import { RequestState } from './RequestState';
import { StatusChip } from './StatusChip';
import { ReplyComposer } from './ReplyComposer';

export const ConversationThread = memo(function ConversationThread({
  conversationId,
  customerName,
  status,
}: {
  conversationId: string;
  customerName: string;
  status: Conversation['status'];
}) {
  const { text } = useTranslation();
  const live = useConversationLive();
  const thread = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: ({ signal }) => live.loadMessages(conversationId, signal),
  });
  const send = useStore(live.store, (state) => state.sends[conversationId]);
  const failedReplies = useStore(live.store, (state) => state.failedReplies[conversationId]);
  const localMessage = send?.message;
  const afterMessageId = send?.afterMessageId;
  const order = send?.order ?? 0;
  const messages = useMemo(
    () =>
      mergeReplyMessages(thread.data?.messages ?? [], [
        ...(failedReplies ?? []),
        ...(localMessage
          ? [{ message: localMessage, order, ...(afterMessageId !== undefined ? { afterMessageId } : {}) }]
          : []),
      ]),
    [thread.data?.messages, failedReplies, localMessage, afterMessageId, order],
  );

  return (
    <Card role="region" aria-label={text.conversationWith(customerName)} className="h-full min-h-0">
      <Card.Header className="shrink-0 flex-row items-center gap-2">
        <Avatar size="sm" aria-hidden="true">
          <Avatar.Fallback>
            <UserIcon size={20} />
          </Avatar.Fallback>
        </Avatar>
        <Surface variant="transparent" className="min-w-0 flex-1">
          <Card.Title aria-level={2} className="truncate">
            {customerName}
          </Card.Title>
          <Card.Description>
            {thread.data ? text.messageCount(messages.length) : text.conversationHistory}
          </Card.Description>
        </Surface>
        <StatusChip status={status} />
        <Tooltip>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            aria-label={text.reloadMessages}
            isPending={thread.isFetching}
            onPress={() => {
              void thread.refetch();
            }}
          >
            <ArrowClockwiseIcon aria-hidden="true" size={18} />
          </Button>
          <Tooltip.Content>{text.reloadMessages}</Tooltip.Content>
        </Tooltip>
      </Card.Header>
      <MessageList
        messages={messages}
        customerName={customerName}
        canReply={status === 'human' && thread.isSuccess}
      >
        {thread.isPending ? (
          <RequestState title={text.loadingMessages} loading />
        ) : thread.isError ? (
          <RequestState
            title={text.messagesError}
            onRetry={() => {
              void thread.refetch();
            }}
          />
        ) : !messages.length ? (
          <RequestState title={text.noMessages} />
        ) : null}
      </MessageList>
      {status !== 'ai' ? (
        <Card.Footer className="shrink-0 flex-col items-stretch gap-2">
          <HandoffNotice conversationId={conversationId} status={status} />
          {status === 'closed' ? (
            <Surface variant="transparent" className="flex items-center gap-2 text-muted">
              <LockSimpleIcon aria-hidden="true" size={16} />
              <Typography type="body-xs" color="muted">
                {text.conversationClosed}
              </Typography>
            </Surface>
          ) : null}
          <ReplyComposer conversationId={conversationId} status={status} historyLoaded={thread.isSuccess} />
        </Card.Footer>
      ) : null}
    </Card>
  );
});
