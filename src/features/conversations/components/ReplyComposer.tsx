import { memo } from 'react';
import { Button, Form, TextArea, TextField } from '@heroui/react';
import { PaperPlaneTiltIcon } from '@phosphor-icons/react';
import { useStore } from 'zustand';
import type { Conversation } from '../../../domain/conversation';
import { useTranslation } from '../../../i18n/useTranslation';
import { useConversationLive } from '../live/LiveProvider';

export const ReplyComposer = memo(function ReplyComposer({
  conversationId,
  status,
  historyLoaded,
}: {
  conversationId: string;
  status: Conversation['status'];
  historyLoaded: boolean;
}) {
  const { text } = useTranslation();
  const live = useConversationLive();
  const draft = useStore(live.store, (state) => state.drafts[conversationId] ?? '');
  const send = useStore(live.store, (state) => state.sends[conversationId]);
  const canReply = status === 'human' && historyLoaded;
  const busy = send?.status === 'sending' || send?.status === 'uncertain';
  if (status !== 'human') return null;

  return (
    <Form
      className="flex w-full items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (canReply && draft.trim() && !busy) void live.sendReply(conversationId);
      }}
    >
      <TextField
        aria-label={text.reply}
        name="reply"
        value={draft}
        onChange={(text) => live.setDraft(conversationId, text)}
        isDisabled={!historyLoaded}
        className="min-w-0 flex-1"
      >
        <TextArea
          dir="auto"
          variant="secondary"
          rows={1}
          placeholder={text.replyPlaceholder}
          className="field-sizing-content max-h-32 min-h-11 w-full resize-none py-2.5 leading-5"
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            if (!event.repeat) event.currentTarget.form?.requestSubmit();
          }}
        />
      </TextField>
      <Button
        type="submit"
        className="h-11 shrink-0"
        isPending={send?.status === 'sending'}
        isDisabled={!canReply || !draft.trim() || busy}
      >
        <PaperPlaneTiltIcon aria-hidden="true" size={18} />
        {text.send}
      </Button>
    </Form>
  );
});
