import type { ReactNode } from 'react';
import { Avatar, Button, Card, Chip, ListBox, Surface, Tooltip, Typography } from '@heroui/react';
import { ArrowClockwiseIcon, ChatsCircleIcon } from '@phosphor-icons/react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ConversationsResponse } from '../../../domain/conversation';
import { useTranslation } from '../../../i18n/useTranslation';
import { ConversationPreview } from './ConversationPreview';
import { RequestState } from './RequestState';
import { StatusChip } from './StatusChip';

type Props = {
  list: UseQueryResult<ConversationsResponse>;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  headerAction?: ReactNode;
};

export function ConversationList({ list, selectedId, onSelect, headerAction }: Props) {
  const { text, format } = useTranslation();
  const conversations = list.data?.conversations ?? [];
  return (
    <Card role="region" aria-label={text.inboxRegion} variant="transparent" className="min-h-0 flex-1 p-0">
      <Card.Header className="flex-row items-center gap-2">
        <ChatsCircleIcon aria-hidden="true" size={20} />
        <Card.Title aria-level={2} className="flex-1">
          {text.inbox}
        </Card.Title>
        {list.data ? (
          <Chip size="sm" variant="soft" aria-label={text.conversationCount(conversations.length)}>
            {format.number.format(conversations.length)}
          </Chip>
        ) : null}
        <Tooltip>
          <Button
            isIconOnly
            variant="ghost"
            size="sm"
            aria-label={text.reloadConversations}
            isPending={list.isFetching}
            onPress={() => {
              void list.refetch();
            }}
          >
            <ArrowClockwiseIcon aria-hidden="true" size={18} />
          </Button>
          <Tooltip.Content>{text.reloadConversations}</Tooltip.Content>
        </Tooltip>
        {headerAction}
      </Card.Header>
      {list.isPending ? (
        <RequestState title={text.loadingConversations} loading />
      ) : list.isError ? (
        <RequestState
          title={text.conversationsError}
          onRetry={() => {
            void list.refetch();
          }}
        />
      ) : conversations.length ? (
        <ListBox
          aria-label={text.conversations}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={selectedId ? [selectedId] : []}
          onSelectionChange={(keys) => {
            const id = Array.from(keys)[0];
            if (id) onSelect(String(id));
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {conversations.map((conversation) => (
            <ListBox.Item
              key={conversation.id}
              id={conversation.id}
              textValue={conversation.customer}
              className="data-[selected=true]:bg-accent/10"
            >
              <Avatar size="sm" aria-hidden="true" className="mt-1 shrink-0 self-start">
                <Avatar.Fallback>
                  {conversation.customer
                    .split(/\s+/)
                    .slice(0, 2)
                    .map((part) => part[0])
                    .join('')}
                </Avatar.Fallback>
              </Avatar>
              <Surface variant="transparent" className="grid min-w-0 flex-1 gap-1">
                <Surface variant="transparent" className="flex min-w-0 items-center justify-between gap-2">
                  <Typography dir="auto" type="body-sm" weight="medium" className="truncate">
                    {conversation.customer}
                  </Typography>
                  {conversation.unread > 0 ? (
                    <Chip size="sm" color="accent" aria-label={text.unreadCount(conversation.unread)}>
                      {format.number.format(conversation.unread)}
                    </Chip>
                  ) : null}
                </Surface>
                <ConversationPreview
                  conversationId={conversation.id}
                  lastMessage={conversation.lastMessage}
                />
                <StatusChip status={conversation.status} />
              </Surface>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      ) : (
        <RequestState title={text.noConversations} />
      )}
    </Card>
  );
}
