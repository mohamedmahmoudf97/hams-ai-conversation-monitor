import { memo } from 'react';
import { Description } from '@heroui/react';
import { useStore } from 'zustand';
import { useTranslation } from '../../../i18n/useTranslation';
import { useConversationLive } from '../live/LiveProvider';

export const ConversationPreview = memo(function ConversationPreview({
  conversationId,
  lastMessage,
}: {
  conversationId: string;
  lastMessage: string;
}) {
  const { text } = useTranslation();
  const live = useConversationLive();
  const preview = useStore(live.store, (state) => state.streams[conversationId]?.text);
  return (
    <Description dir="auto" className="truncate">
      {preview === undefined ? lastMessage || text.noMessages : preview || text.aiReplying}
    </Description>
  );
});
