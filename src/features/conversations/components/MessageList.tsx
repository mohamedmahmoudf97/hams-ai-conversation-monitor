import { memo, useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Chip, ScrollShadow, Surface, Tooltip } from '@heroui/react';
import { ArrowDownIcon } from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Message } from '../../../domain/conversation';
import { useTranslation } from '../../../i18n/useTranslation';

import { MessageRow } from './MessageRow';
import { useFollowLatest } from './useFollowLatest';

export const MessageList = memo(function MessageList({
  messages,
  customerName,
  canReply,
  children,
}: {
  messages: Message[];
  customerName: string;
  canReply: boolean;
  children: ReactNode;
}) {
  const { text } = useTranslation();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const getItemKey = useCallback((index: number) => messages[index]!.id, [messages]);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollElement,
    getItemKey,
    estimateSize: () => 120,
    overscan: 5,
    directDomUpdates: true,
  });

  const scrollToLatest = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      if (messages.length) virtualizer.scrollToEnd({ behavior });
    },
    [messages.length, virtualizer],
  );
  const { away, newCount, jumpToLatest } = useFollowLatest(
    messages,
    scrollElement,
    scrollToLatest,
    virtualizer.cancelScroll,
  );

  return (
    <Surface variant="transparent" className="relative flex min-h-0 flex-1 flex-col">
      <ScrollShadow
        ref={setScrollElement}
        className="min-h-0 flex-1"
        aria-label={text.messageHistory}
        tabIndex={0}
      >
        {children ?? (
          <Surface
            ref={virtualizer.containerRef}
            variant="transparent"
            role="list"
            aria-label={text.messages}
            className="relative w-full"
          >
            {virtualizer.getVirtualItems().map((row) => {
              const message = messages[row.index]!;
              return (
                <Surface
                  key={message.id}
                  ref={virtualizer.measureElement}
                  data-index={row.index}
                  variant="transparent"
                  role="listitem"
                  aria-posinset={row.index + 1}
                  aria-setsize={messages.length}
                  className="absolute inset-s-0 top-0 w-full py-1"
                >
                  <MessageRow message={message} customerName={customerName} canReply={canReply} />
                </Surface>
              );
            })}
          </Surface>
        )}
      </ScrollShadow>
      {away && messages.length > 0 && !children ? (
        <Surface
          variant="transparent"
          className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex flex-col items-center gap-1"
        >
          {newCount > 0 ? (
            <Chip size="sm" variant="primary" role="status" aria-live="polite" aria-atomic="true">
              {text.newMessageCount(newCount)}
            </Chip>
          ) : null}
          <Tooltip>
            <Button
              isIconOnly
              variant="secondary"
              className="pointer-events-auto rounded-full shadow-sm"
              aria-label={text.jumpToLatest}
              onPress={jumpToLatest}
            >
              <ArrowDownIcon aria-hidden="true" size={20} />
            </Button>
            <Tooltip.Content>{text.jumpToLatest}</Tooltip.Content>
          </Tooltip>
        </Surface>
      ) : null}
    </Surface>
  );
});
