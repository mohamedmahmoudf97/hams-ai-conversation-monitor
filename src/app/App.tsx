import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { Avatar, Button, Card, Drawer, I18nProvider, Surface, Tooltip } from '@heroui/react';
import { ListIcon } from '@phosphor-icons/react';
import { useQuery } from '@tanstack/react-query';
import { useConversationLive } from '../features/conversations/live/LiveProvider';
import { ConnectionToast } from '../features/conversations/components/ConnectionToast';
import { ConversationThread } from '../features/conversations/components/ConversationThread';
import { ConversationList } from '../features/conversations/components/ConversationList';
import { RequestState } from '../features/conversations/components/RequestState';
import { messages, type Locale } from '../i18n/messages';
import { LanguageControls } from './LanguageControls';

const desktopQuery = '(min-width: 1024px)';
const isDesktopLayout = () => window.matchMedia(desktopQuery).matches;
function subscribeToLayout(onChange: () => void) {
  const media = window.matchMedia(desktopQuery);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

export function App() {
  const live = useConversationLive();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [locale, setLocale] = useState<Locale>(() =>
    document.documentElement.lang.startsWith('ar') ? 'ar' : 'en',
  );
  const direction = locale === 'ar' ? 'rtl' : 'ltr';
  const text = messages[locale];
  const isDesktop = useSyncExternalStore(subscribeToLayout, isDesktopLayout);
  const list = useQuery({
    queryKey: ['conversations'],
    queryFn: ({ signal }) => live.loadConversations(signal),
  });
  const conversations = list.data?.conversations ?? [];
  const selected = conversations.find(({ id }) => id === selectedId) ?? conversations[0];

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = direction;
    document.title = text.pageTitle;
  }, [locale, direction, text.pageTitle]);

  useEffect(() => {
    if (selectedId === null && conversations[0]) setSelectedId(conversations[0].id);
  }, [conversations, selectedId]);

  useEffect(() => {
    if (isDesktop) setInboxOpen(false);
  }, [isDesktop]);

  return (
    <I18nProvider locale={locale}>
      <ConnectionToast />
      <Surface
        variant="transparent"
        role="main"
        className="mx-auto flex h-dvh max-w-7xl flex-col gap-3 p-3 sm:p-4"
      >
        <Surface
          variant="transparent"
          className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex"
        >
          <Surface variant="transparent" className="flex min-w-0 items-center gap-2">
            {!isDesktop ? (
              <Tooltip>
                <Button
                  isIconOnly
                  variant="ghost"
                  aria-label={text.openInbox}
                  aria-haspopup="dialog"
                  aria-expanded={inboxOpen}
                  onPress={() => setInboxOpen(true)}
                >
                  <ListIcon aria-hidden="true" size={22} />
                </Button>
                <Tooltip.Content>{text.openInbox}</Tooltip.Content>
              </Tooltip>
            ) : null}
            <Avatar className="h-10 w-28 rounded-none bg-transparent">
              <Avatar.Image src="/hams-logo.svg" alt="Hams.AI" className="rounded-none object-contain" />
              <Avatar.Fallback>Hams.AI</Avatar.Fallback>
            </Avatar>
          </Surface>
          <LanguageControls locale={locale} onChange={setLocale} />
        </Surface>

        <Surface
          variant="transparent"
          className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[300px_minmax(0,1fr)]"
        >
          {isDesktop ? (
            <ConversationList list={list} selectedId={selected?.id} onSelect={setSelectedId} />
          ) : null}
          {selected ? (
            <ConversationThread
              key={selected.id}
              conversationId={selected.id}
              customerName={selected.customer}
              status={selected.status}
            />
          ) : (
            <Card className="self-start">
              <RequestState title={text.selectConversation} />
            </Card>
          )}
        </Surface>
        {!isDesktop ? (
          <Drawer.Backdrop isOpen={inboxOpen} onOpenChange={setInboxOpen}>
            <Drawer.Content placement={direction === 'rtl' ? 'right' : 'left'} className="justify-start">
              <Drawer.Dialog aria-label={text.inboxRegion} className="p-0">
                <Drawer.Body className="m-0 flex overflow-hidden p-0">
                  <ConversationList
                    list={list}
                    selectedId={selected?.id}
                    onSelect={(id) => {
                      setSelectedId(id);
                      setInboxOpen(false);
                    }}
                    headerAction={
                      <Tooltip>
                        <Drawer.CloseTrigger className="static" aria-label={text.closeInbox} />
                        <Tooltip.Content>{text.closeInbox}</Tooltip.Content>
                      </Tooltip>
                    }
                  />
                </Drawer.Body>
              </Drawer.Dialog>
            </Drawer.Content>
          </Drawer.Backdrop>
        ) : null}
      </Surface>
    </I18nProvider>
  );
}
