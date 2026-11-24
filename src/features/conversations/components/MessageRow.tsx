import { memo } from 'react';
import { Button, Card, Chip, Typography } from '@heroui/react';
import { ArrowClockwiseIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useStore } from 'zustand';
import type { Message } from '../../../domain/conversation';
import { translateError } from '../../../i18n/messages';
import { useTranslation } from '../../../i18n/useTranslation';
import { useConversationLive } from '../live/LiveProvider';

export const MessageRow = memo(function MessageRow({
  message,
  customerName,
  canReply = false,
}: {
  message: Message;
  customerName: string;
  canReply?: boolean;
}) {
  const { text, format, locale } = useTranslation();
  const live = useConversationLive();
  const overlay = useStore(live.store, (state) => {
    const stream = state.streams[message.conversationId];
    return stream?.id === message.id ? stream : undefined;
  });
  const attempt = useStore(live.store, (state) => {
    const send = state.sends[message.conversationId];
    return send?.message.id === message.id
      ? send
      : state.failedReplies[message.conversationId]?.find((reply) => reply.message.id === message.id);
  });
  const otherSendBusy = useStore(live.store, (state) => {
    const send = state.sends[message.conversationId];
    return Boolean(attempt && send && send.message.id !== message.id && send.status !== 'failed');
  });
  const delivery = attempt?.status;
  const current = overlay ?? message;
  const isCustomer = current.role === 'customer';

  return (
    <Card
      variant={isCustomer ? 'secondary' : 'tertiary'}
      className={`w-fit max-w-[92%] gap-1 p-3 shadow-none sm:max-w-[80%] ${isCustomer ? 'ml-0 mr-auto' : 'ml-auto mr-0'}`}
    >
      <Card.Header>
        <Typography
          dir="auto"
          type="body-xs"
          weight="semibold"
          className={isCustomer ? 'text-left' : 'text-right'}
        >
          {current.role === 'customer' ? customerName : text.roles[current.role]}
        </Typography>
      </Card.Header>
      <Card.Content>
        <Typography dir="auto" type="body-sm" className="whitespace-pre-wrap wrap-anywhere">
          {current.text || (current.streaming ? text.replyStarted : '')}
        </Typography>
        {delivery === 'uncertain' ? (
          <Typography type="body-xs" className="mt-1 text-warning" role="status">
            {text.duplicateWarning}
          </Typography>
        ) : null}
      </Card.Content>
      <Card.Footer className="flex-wrap justify-end gap-2">
        {current.streaming ? (
          <Chip size="sm" variant="soft">
            {text.aiReplying}
          </Chip>
        ) : null}
        {delivery ? (
          <Chip
            size="sm"
            variant="soft"
            color={delivery === 'failed' ? 'danger' : delivery === 'uncertain' ? 'warning' : 'default'}
            role="status"
            title={translateError(attempt?.error, locale)}
          >
            {delivery === 'failed' ? <WarningCircleIcon aria-hidden="true" size={14} /> : null}
            {delivery === 'failed'
              ? text.replyNotSent
              : delivery === 'sending' ? text.sending : text.deliveryUnconfirmed}
          </Chip>
        ) : null}
        {delivery === 'uncertain' ? (
          <Button
            size="sm"
            variant="ghost"
            isPending={attempt?.checking ?? false}
            onPress={() => {
              void live.checkDelivery(message.conversationId);
            }}
          >
            {text.checkDelivery}
          </Button>
        ) : null}
        {delivery === 'failed' || delivery === 'uncertain' ? (
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!canReply || otherSendBusy || Boolean(attempt?.checking)}
            onPress={() => {
              void live.retryReply(message.conversationId, message.id);
            }}
          >
            <ArrowClockwiseIcon aria-hidden="true" size={14} />
            {delivery === 'failed' ? text.retryReply : text.sendAgain}
          </Button>
        ) : null}
        <Typography
          type="body-xs"
          color="muted"
          title={format.dateTime.format(new Date(current.createdAt))}
        >
          {format.time.format(new Date(current.createdAt))}
        </Typography>
      </Card.Footer>
    </Card>
  );
});
