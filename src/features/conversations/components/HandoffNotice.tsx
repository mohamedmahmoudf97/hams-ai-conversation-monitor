import { memo } from 'react';
import { Alert, Button } from '@heroui/react';
import { HeadsetIcon } from '@phosphor-icons/react';
import { useStore } from 'zustand';
import type { Conversation } from '../../../domain/conversation';
import { translateError } from '../../../i18n/messages';
import { useTranslation } from '../../../i18n/useTranslation';
import { useConversationLive } from '../live/LiveProvider';

export const HandoffNotice = memo(function HandoffNotice({
  conversationId,
  status,
}: {
  conversationId: string;
  status: Conversation['status'];
}) {
  const { text, locale } = useTranslation();
  const live = useConversationLive();
  const reason = useStore(live.store, (state) => state.handoffs[conversationId]);
  const takeover = useStore(live.store, (state) => state.takeovers[conversationId]);
  if (status !== 'needs_human') return null;
  return (
    <Alert
      status={takeover?.error ? 'danger' : 'warning'}
      role={takeover?.error ? 'alert' : 'status'}
      className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)] bg-surface-tertiary text-surface-tertiary-foreground shadow-none sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center"
    >
      <Alert.Indicator />
      <Alert.Content className="min-w-0">
        <Alert.Title>{takeover?.error ? text.takeoverError : text.humanAssistanceRequested}</Alert.Title>
        <Alert.Description dir="auto" className="wrap-anywhere">
          {reason || text.reasonUnavailable}
        </Alert.Description>
        {takeover?.error ? (
          <Alert.Description dir="auto" className="wrap-anywhere">
            {translateError(takeover.error, locale)}
          </Alert.Description>
        ) : null}
      </Alert.Content>
      <Button
        className="col-start-2 justify-self-start sm:col-start-auto sm:justify-self-end"
        isPending={takeover?.pending ?? false}
        onPress={() => {
          void live.takeOver(conversationId);
        }}
      >
        <HeadsetIcon aria-hidden="true" size={18} />
        {takeover?.pending ? text.takingOver : takeover?.error ? text.retryTakeover : text.takeOver}
      </Button>
    </Alert>
  );
});
