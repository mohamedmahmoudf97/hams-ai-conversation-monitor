// @vitest-environment jsdom
import { StrictMode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '../domain/conversation';
import { LiveProvider } from '../features/conversations/live/LiveProvider';
import type { LiveEvent } from '../features/conversations/live/events';
import { App } from './App';
import { messages as copy } from '../i18n/messages';

vi.mock('@tanstack/react-query', async (original) => {
  const actual = await original<typeof import('@tanstack/react-query')>();
  return { ...actual, useQuery: vi.fn(actual.useQuery) };
});
vi.mock('@tanstack/react-virtual', async (original) => {
  const actual = await original<typeof import('@tanstack/react-virtual')>();
  return { ...actual, useVirtualizer: vi.fn(actual.useVirtualizer) };
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  send(event: LiveEvent) {
    this.onmessage?.(
      new MessageEvent('message', { data: JSON.stringify(event), lastEventId: String(event.id) }),
    );
  }
}

const conversations: Conversation[] = ['ai', 'needs_human', 'human', 'closed'].map((status, index) => ({
  id: `c-${index + 1}`,
  customer: ['Sara', 'Omar', 'نورة', 'John'][index]!,
  status: status as Conversation['status'],
  lastMessage: `Preview ${index + 1}`,
  unread: index,
  updatedAt: '2026-11-23T12:00:00.000Z',
}));
const fetcher = vi.fn<typeof fetch>();
let viewportWidth = 1440;
let layoutChanges: EventTarget;

function resizeLayout(width: number) {
  act(() => {
    viewportWidth = width;
    layoutChanges.dispatchEvent(new Event('change'));
  });
}
const thread = (id: string, text = `${id} reply`) => ({
  lastEventId: 4,
  messages: [
    { id: `m-${id}`, conversationId: id, role: 'customer', text, createdAt: '2026-11-23T12:00:00.000Z' },
  ],
});
const reply = (url: string) =>
  Response.json(
    url.endsWith('/conversations') ? { lastEventId: 4, conversations } : thread(url.split('/').at(-2)!),
  );

function mount(gcTime = 0) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime } },
  });
  return render(
    <QueryClientProvider client={client}>
      <LiveProvider>
        <App />
      </LiveProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  document.documentElement.dir = 'ltr';
  document.documentElement.lang = 'en';
  viewportWidth = 1440;
  layoutChanges = new EventTarget();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.startsWith('(min-width:') && viewportWidth >= Number(query.match(/\d+/)?.[0]),
    media: query,
    onchange: null,
    addEventListener: layoutChanges.addEventListener.bind(layoutChanges),
    removeEventListener: layoutChanges.removeEventListener.bind(layoutChanges),
    dispatchEvent: layoutChanges.dispatchEvent.bind(layoutChanges),
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }));
  fetcher.mockReset().mockImplementation(async (input) => reply(String(input)));
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('CSS', { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&') });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.scrollTo = vi.fn(function (
    this: Element,
    options?: ScrollToOptions | number,
    y?: number,
  ) {
    const top = typeof options === 'number' ? y : options?.top;
    this.scrollTop = Math.max(0, Math.min(top ?? 0, this.scrollHeight - this.clientHeight));
    queueMicrotask(() => this.dispatchEvent(new Event('scroll')));
  });
  // JSDOM has no layout; supply viewport and row sizes to the real virtualizer.
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    const height = this.querySelector<HTMLElement>('[role="list"]')?.style.height;
    return Math.max(this.clientHeight, Number.parseFloat(height || '0'));
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps one live connection in StrictMode and closes it on unmount', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { unmount } = render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <LiveProvider>
          <App />
        </LiveProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
  await screen.findByText('c-1 reply');
  expect(FakeEventSource.instances.filter((source) => !source.close.mock.calls.length)).toHaveLength(1);
  unmount();
  expect(FakeEventSource.instances.filter((source) => !source.close.mock.calls.length)).toHaveLength(0);
});

it('loads the first conversation automatically and labels all four statuses', async () => {
  mount();
  expect(screen.getByText('Loading conversations…')).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Sara' })).toBeTruthy();
  expect(await screen.findByText('c-1 reply')).toBeTruthy();
  const list = within(screen.getByRole('listbox', { name: 'Conversations' }));
  for (const label of ['AI handling', 'Needs human', 'Human handling', 'Closed']) {
    expect(list.getByText(label)).toBeTruthy();
  }
  expect(list.getByRole('option', { name: /Sara/ }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Open inbox' })).toBeNull();
});

it('skips thread and virtualizer work for unrelated inbox updates while status and history stay live', async () => {
  mount();
  await screen.findByText('c-1 reply');
  vi.mocked(useQuery).mockClear();
  vi.mocked(useVirtualizer).mockClear();
  const incoming = (id: string): Message => ({
    id: `new-${id}`, conversationId: id, role: 'customer', text: `${id} new question`,
    createdAt: '2026-11-24T12:00:00.000Z',
  });
  act(() => FakeEventSource.instances[0]!.send({
    id: 5, type: 'message', conversationId: 'c-2', message: incoming('c-2'),
  }));
  await screen.findByText('c-2 new question');
  expect(vi.mocked(useQuery).mock.calls.some(([options]) => options.queryKey[0] === 'messages')).toBe(false);
  expect(useVirtualizer).not.toHaveBeenCalled();

  act(() => FakeEventSource.instances[0]!.send({
    id: 6, type: 'status', conversationId: 'c-1', status: 'needs_human',
  }));
  await screen.findByRole('button', { name: copy.en.takeOver });
  expect(vi.mocked(useQuery).mock.calls.some(([options]) => options.queryKey[0] === 'messages')).toBe(true);
  expect(useVirtualizer).not.toHaveBeenCalled();

  act(() => FakeEventSource.instances[0]!.send({
    id: 7, type: 'message', conversationId: 'c-1', message: incoming('c-1'),
  }));
  const history = within(screen.getByLabelText(copy.en.messageHistory));
  expect(await history.findByText('c-1 new question')).toBeTruthy();
  expect(useVirtualizer).toHaveBeenCalled();
});

it('opens the mobile inbox, selects a conversation, and returns focus to its menu button', async () => {
  resizeLayout(390);
  mount();
  const user = userEvent.setup();
  await screen.findByText('c-1 reply');
  expect(screen.queryByRole('listbox', { name: 'Conversations' })).toBeNull();
  const menu = screen.getByRole('button', { name: 'Open inbox' });
  await user.click(menu);
  const drawer = await screen.findByRole('dialog', { name: 'Conversation inbox' });
  expect(within(drawer).getByRole('option', { name: /Sara/ }).getAttribute('aria-selected')).toBe('true');
  await user.click(within(drawer).getByRole('option', { name: /Omar/ }));
  expect(await screen.findByText('c-2 reply')).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(menu));
  await user.click(menu);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('heading', { name: 'Omar' })).toBeTruthy();
  await user.click(menu);
  await user.click(screen.getByRole('button', { name: 'Close inbox' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('closes the drawer when switching to desktop and keeps it closed when returning to mobile', async () => {
  resizeLayout(768);
  mount();
  await screen.findByText('c-1 reply');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open inbox' }));
  await screen.findByRole('dialog', { name: 'Conversation inbox' });
  resizeLayout(1221);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getAllByRole('listbox', { name: 'Conversations' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Open inbox' })).toBeNull();
  resizeLayout(768);
  expect(screen.getByRole('button', { name: 'Open inbox' }).getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('listbox', { name: 'Conversations' })).toBeNull();
  expect(screen.getByText('c-1 reply')).toBeTruthy();
});

it('changes language and direction without losing the active thread or draft', async () => {
  mount();
  const user = userEvent.setup();
  await screen.findByText('c-1 reply');
  const initialMessage = within(screen.getByLabelText(copy.en.messageHistory)).getByRole('listitem');
  expect(within(initialMessage).getByText('Sara')).toBeTruthy();
  await user.click(screen.getByRole('option', { name: /نورة/ }));
  await screen.findByText('c-3 reply');
  const selectedMessage = within(screen.getByLabelText(copy.en.messageHistory)).getByRole('listitem');
  expect(within(selectedMessage).getByText('نورة')).toBeTruthy();
  expect(within(selectedMessage).queryByText('Sara')).toBeNull();
  const composer = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;
  await user.type(composer, 'Hello مرحباً');
  const controls = within(screen.getByRole('group', { name: copy.en.language }));
  const rtl = controls.getByRole('button', { name: 'Ar — العربية' });
  rtl.focus();
  await user.keyboard('{Enter}');
  expect(document.documentElement.dir).toBe('rtl');
  expect(document.documentElement.lang).toBe('ar');
  expect(document.title).toBe(copy.ar.pageTitle);
  expect(screen.getByRole('heading', { name: copy.ar.inbox })).toBeTruthy();
  expect(screen.getByRole('textbox', { name: copy.ar.reply })).toBe(composer);
  expect(screen.getByRole('button', { name: copy.ar.send })).toBeTruthy();
  expect(screen.getByText(copy.ar.messageCount(1))).toBeTruthy();
  expect(rtl.getAttribute('aria-pressed')).toBe('true');
  expect(controls.getByRole('button', { name: 'En — English' }).getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByRole('heading', { name: 'نورة' }).getAttribute('dir')).toBeNull();
  expect(within(selectedMessage).getByText('نورة')).toBeTruthy();
  expect(screen.getByLabelText(copy.ar.messageHistory).getAttribute('dir')).toBeNull();
  expect(screen.getByText('c-3 reply').getAttribute('dir')).toBe('auto');
  expect(composer.getAttribute('dir')).toBe('auto');
  expect(composer.value).toBe('Hello مرحباً');
  expect(FakeEventSource.instances).toHaveLength(1);
  await user.click(controls.getByRole('button', { name: 'En — English' }));
  expect(document.documentElement.dir).toBe('ltr');
  expect(document.documentElement.lang).toBe('en');
  expect(document.title).toBe(copy.en.pageTitle);
  expect(screen.getByRole('textbox', { name: copy.en.reply })).toBe(composer);
  expect(composer.value).toBe('Hello مرحباً');
});

it('opens the mobile drawer on the logical start side in each direction', async () => {
  resizeLayout(390);
  mount();
  const user = userEvent.setup();
  await screen.findByText('c-1 reply');
  await user.click(screen.getByRole('button', { name: 'Ar — العربية' }));
  await user.click(screen.getByRole('button', { name: copy.ar.openInbox }));
  const drawer = await screen.findByRole('dialog', { name: copy.ar.inboxRegion });
  expect(drawer.closest('[data-placement]')?.getAttribute('data-placement')).toBe('right');
  expect(document.documentElement.dir).toBe('rtl');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'En — English' }));
  await user.click(screen.getByRole('button', { name: 'Open inbox' }));
  const ltrDrawer = await screen.findByRole('dialog', { name: 'Conversation inbox' });
  expect(ltrDrawer.closest('[data-placement]')?.getAttribute('data-placement')).toBe('left');
});

it('clears the previous thread on selection and ignores a late response after switching again', async () => {
  let resolveSlow!: (response: Response) => void;
  const slow = new Promise<Response>((resolve) => {
    resolveSlow = resolve;
  });
  fetcher.mockImplementation(async (input) =>
    String(input).endsWith('/c-2/messages') ? slow : reply(String(input)),
  );
  mount();
  await screen.findByText('c-1 reply');
  const user = userEvent.setup();
  await user.click(screen.getByRole('option', { name: /Omar/ }));
  expect(await screen.findByRole('heading', { name: 'Omar' })).toBeTruthy();
  expect(screen.getByText('Loading messages…')).toBeTruthy();
  expect(screen.queryByText('c-1 reply')).toBeNull();
  await user.click(screen.getByRole('option', { name: /نورة/ }));
  expect(await screen.findByText('c-3 reply')).toBeTruthy();
  const slowRequest = fetcher.mock.calls.find(([input]) => String(input).endsWith('/c-2/messages'));
  expect(slowRequest?.[1]?.signal?.aborted).toBe(true);
  await act(async () => {
    resolveSlow(Response.json(thread('c-2')));
  });
  expect(screen.getByRole('heading', { name: 'نورة' })).toBeTruthy();
  expect(screen.getByText('c-3 reply')).toBeTruthy();
  expect(screen.queryByText('c-2 reply')).toBeNull();
});

it('lets the user retry a failed conversation list', async () => {
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Service unavailable' }, { status: 503 }));
  mount();
  expect(await screen.findByText('Could not load conversations')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('c-1 reply')).toBeTruthy();
});

it('renders a cached thread when returning to a conversation without another request', async () => {
  mount(Infinity);
  const user = userEvent.setup();
  await screen.findByText('c-1 reply');
  await user.click(screen.getByRole('option', { name: /Omar/ }));
  await screen.findByText('c-2 reply');
  await user.click(screen.getByRole('option', { name: /Sara/ }));
  expect(await screen.findByText('c-1 reply')).toBeTruthy();
  expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/c-1/messages'))).toHaveLength(1);
});

it('lets the user retry a failed message thread', async () => {
  fetcher.mockResolvedValueOnce(reply('/conversations'));
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Thread unavailable' }, { status: 503 }));
  mount();
  expect(await screen.findByText('Could not load messages')).toBeTruthy();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('c-1 reply')).toBeTruthy();
});

it('shows an empty inbox without requesting a thread', async () => {
  fetcher.mockResolvedValue(Response.json({ lastEventId: 0, conversations: [] }));
  mount();
  expect(await screen.findByText('No conversations yet')).toBeTruthy();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('shows an empty thread', async () => {
  fetcher.mockImplementation(async (input) =>
    String(input).endsWith('/conversations')
      ? reply(String(input))
      : Response.json({ lastEventId: 4, messages: [] }),
  );
  mount();
  expect(await screen.findByText('No messages yet')).toBeTruthy();
});

it('renders message content as plain text', async () => {
  const text = '<img src=x onerror="alert(1)"> مرحباً';
  fetcher.mockImplementation(async (input) =>
    String(input).endsWith('/conversations') ? reply(String(input)) : Response.json(thread('c-1', text)),
  );
  mount();
  const message = await screen.findByText(text);
  expect(message.querySelector('img')).toBeNull();
  expect(message.textContent).toBe(text);
});

it('keeps closed conversations selectable with a read-only explanation', async () => {
  mount();
  await screen.findByText('c-1 reply');
  await userEvent.setup().click(screen.getByRole('option', { name: /John/ }));
  expect(await screen.findByText('c-4 reply')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'John' })).toBeTruthy();
  expect(screen.getByText('This conversation is closed.')).toBeTruthy();
});

it('streams mixed-language text into the row and preview, then commits the completed reply', async () => {
  mount();
  await screen.findByText('c-1 reply');
  const source = FakeEventSource.instances[0]!;
  expect(source.url).toMatch(/\/events\?since=4$/);
  act(() => {
    source.onopen?.();
    source.send({ id: 5, type: 'message_start', conversationId: 'c-1', messageId: 'm-live', role: 'ai' });
    source.send({ id: 6, type: 'token', conversationId: 'c-1', messageId: 'm-live', text: 'مرحباً Premium' });
  });
  expect(screen.queryByText('Connected')).toBeNull();
  const history = within(screen.getByLabelText('Message history'));
  expect(await history.findByText('مرحباً Premium')).toBeTruthy();
  expect(history.getByText('مرحباً Premium').getAttribute('dir')).toBe('auto');
  expect(history.getByText('AI replying…')).toBeTruthy();
  expect(
    within(screen.getByRole('listbox', { name: 'Conversations' })).getByText('مرحباً Premium'),
  ).toBeTruthy();
  act(() => {
    source.send({ id: 6, type: 'token', conversationId: 'c-1', messageId: 'm-live', text: 'مرحباً Premium' });
    source.send({ id: 7, type: 'token', conversationId: 'c-1', messageId: 'm-live', text: '!' });
    source.send({ id: 8, type: 'message_end', conversationId: 'c-1', messageId: 'm-live' });
  });
  expect(await history.findByText('مرحباً Premium!')).toBeTruthy();
  expect(history.queryByText('AI replying…')).toBeNull();
  act(() => source.onerror?.());
  expect(await screen.findByRole('alertdialog', { name: 'Connection lost' })).toBeTruthy();
  expect(history.getByText('مرحباً Premium!')).toBeTruthy();
});

it('keeps streams isolated when switching away mid-reply and back after completion', async () => {
  fetcher.mockImplementation(async (input) =>
    String(input).endsWith('/c-2/messages')
      ? Response.json({ ...thread('c-2'), lastEventId: 6 })
      : reply(String(input)),
  );
  mount(Infinity);
  await screen.findByText('c-1 reply');
  const source = FakeEventSource.instances[0]!;
  act(() => {
    source.send({ id: 5, type: 'message_start', conversationId: 'c-1', messageId: 'm-live', role: 'ai' });
    source.send({ id: 6, type: 'token', conversationId: 'c-1', messageId: 'm-live', text: 'مرحباً' });
  });
  expect(await within(screen.getByLabelText('Message history')).findByText('مرحباً')).toBeTruthy();

  const user = userEvent.setup();
  await user.click(screen.getByRole('option', { name: /Omar/ }));
  expect(await screen.findByText('c-2 reply')).toBeTruthy();
  const otherHistory = within(screen.getByLabelText('Message history'));
  expect(otherHistory.queryByText('مرحباً')).toBeNull();
  act(() => {
    source.send({ id: 7, type: 'token', conversationId: 'c-1', messageId: 'm-live', text: ' Premium!' });
    source.send({ id: 8, type: 'message_end', conversationId: 'c-1', messageId: 'm-live' });
  });
  expect(
    await within(screen.getByRole('listbox', { name: 'Conversations' })).findByText('مرحباً Premium!'),
  ).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Omar' })).toBeTruthy();
  expect(otherHistory.getByText('c-2 reply')).toBeTruthy();
  expect(otherHistory.queryByText('مرحباً Premium!')).toBeNull();

  await user.click(screen.getByRole('option', { name: /Sara/ }));
  const originalHistory = within(screen.getByLabelText('Message history'));
  expect(await originalHistory.findByText('مرحباً Premium!')).toBeTruthy();
  expect(originalHistory.queryByText('AI replying…')).toBeNull();
  expect(originalHistory.queryByText('c-2 reply')).toBeNull();
  expect(fetcher.mock.calls.filter(([input]) => String(input).endsWith('/c-1/messages'))).toHaveLength(1);
});

it('keeps the selected thread when live activity reorders the inbox and shows an observed handoff reason', async () => {
  mount();
  await screen.findByText('c-1 reply');
  const list = within(screen.getByRole('listbox', { name: 'Conversations' }));
  expect(
    within(list.getByRole('option', { name: /Omar/ })).getByLabelText('1 unread message').textContent,
  ).toBe('1');
  const source = FakeEventSource.instances[0]!;
  act(() =>
    source.send({
      id: 5,
      type: 'message',
      conversationId: 'c-2',
      message: {
        ...thread('c-2').messages[0]!,
        id: 'new-message',
        role: 'customer',
        text: 'New activity',
        createdAt: '2026-11-23T13:00:00.000Z',
      },
    }),
  );
  expect(await list.findByText('New activity')).toBeTruthy();
  expect(
    within(list.getByRole('option', { name: /Omar/ })).getByLabelText('2 unread messages').textContent,
  ).toBe('2');
  expect(list.getAllByRole('option')[0]!.textContent).toContain('Omar');
  expect(screen.getByRole('heading', { name: 'Sara' })).toBeTruthy();
  expect(screen.getByText('c-1 reply')).toBeTruthy();
  act(() => {
    source.send({
      id: 6,
      type: 'tool_call',
      conversationId: 'c-1',
      name: 'transfer_to_human',
      args: { reason: 'Customer requested help with billing' },
    });
    source.send({ id: 7, type: 'status', conversationId: 'c-1', status: 'needs_human' });
  });
  expect(await screen.findByText('Customer requested help with billing')).toBeTruthy();
  expect(screen.getByText('Human assistance requested')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Sara' }).getAttribute('dir')).toBeNull();
});

it('virtualizes 5,000 messages, preserves history in RTL, and resumes following after jumping', async () => {
  const messages = Array.from({ length: 5000 }, (_, index) => ({
    ...thread('c-1').messages[0]!,
    id: `m-${index}`,
    text: `Message ${index}`,
  }));
  fetcher.mockImplementation(async (input) =>
    String(input).endsWith('/conversations')
      ? reply(String(input))
      : Response.json({ lastEventId: 4, messages }),
  );
  mount();
  expect(await screen.findByText('Message 4999')).toBeTruthy();
  const history = screen.getByLabelText('Message history');
  const mounted = within(history).getAllByRole('listitem');
  expect(mounted.length).toBeGreaterThan(0);
  expect(mounted.length).toBeLessThan(40);
  expect(history.scrollTop).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).toBeNull();
  act(() =>
    FakeEventSource.instances[0]!.send({
      id: 5,
      type: 'message',
      conversationId: 'c-1',
      message: { ...thread('c-1').messages[0]!, id: 'm-5000', role: 'customer', text: 'Message 5000' },
    }),
  );
  expect(await within(history).findByText('Message 5000')).toBeTruthy();
  await act(async () => {
    history.scrollTo({ top: 0 });
  });
  expect(await screen.findByText('Message 0')).toBeTruthy();
  expect(screen.queryByText('Message 4999')).toBeNull();
  expect(within(history).getAllByRole('listitem').length).toBeLessThan(40);
  expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Ar — العربية' }));
  expect(history.scrollTop).toBe(0);
  expect(within(history).getByText('Message 0')).toBeTruthy();
  act(() =>
    FakeEventSource.instances[0]!.send({
      id: 6,
      type: 'message',
      conversationId: 'c-1',
      message: { ...thread('c-1').messages[0]!, id: 'm-5001', role: 'customer', text: 'Message 5001' },
    }),
  );
  expect(
    await within(screen.getByRole('listbox', { name: copy.ar.conversations })).findByText('Message 5001'),
  ).toBeTruthy();
  expect(history.scrollTop).toBe(0);
  expect(within(history).getByText('Message 0')).toBeTruthy();
  expect(within(history).queryByText('Message 5001')).toBeNull();
  expect(await screen.findByText(copy.ar.newMessageCount(1))).toBeTruthy();
  act(() =>
    FakeEventSource.instances[0]!.send({
      id: 7,
      type: 'message',
      conversationId: 'c-1',
      message: {
        ...thread('c-1').messages[0]!,
        id: 'm-5001',
        role: 'customer',
        text: 'Message 5001 updated',
      },
    }),
  );
  expect(screen.getByText(copy.ar.newMessageCount(1))).toBeTruthy();
  const jump = screen.getByRole('button', { name: copy.ar.jumpToLatest });
  jump.focus();
  await user.keyboard('{Enter}');
  expect(await within(history).findByText('Message 5001 updated')).toBeTruthy();
  expect(screen.queryByRole('button', { name: copy.ar.jumpToLatest })).toBeNull();
  expect(screen.queryByText(copy.ar.newMessageCount(1))).toBeNull();
  expect(document.activeElement).toBe(history);
  expect(history.scrollTop).toBeGreaterThan(0);
  expect(within(history).getAllByRole('listitem').length).toBeLessThan(40);
  act(() =>
    FakeEventSource.instances[0]!.send({
      id: 8,
      type: 'message',
      conversationId: 'c-1',
      message: { ...thread('c-1').messages[0]!, id: 'm-5002', role: 'customer', text: 'Message 5002' },
    }),
  );
  expect(await within(history).findByText('Message 5002')).toBeTruthy();
  expect(screen.queryByRole('button', { name: copy.ar.jumpToLatest })).toBeNull();
});

it('confirms takeover before enabling replies and lets a failed takeover be retried', async () => {
  let finish!: (response: Response) => void;
  let takeoverRequests = 0;
  fetcher.mockImplementation(async (input, options) => {
    if (options?.method === 'POST') {
      takeoverRequests++;
      if (takeoverRequests === 1) return Response.json({ error: 'Please try again' }, { status: 500 });
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return reply(String(input));
  });
  mount();
  await screen.findByText('c-1 reply');
  expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
  const user = userEvent.setup();
  await user.click(screen.getByRole('option', { name: /Omar/ }));
  await screen.findByText('c-2 reply');
  expect(screen.getByText('Reason not available from the server.')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Take over' }));
  expect(await screen.findByText('Could not take over')).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Retry takeover' }));
  const pending = await screen.findByRole('button', { name: 'Taking over…' });
  await user.click(pending);
  expect(takeoverRequests).toBe(2);
  expect(screen.queryByRole('textbox', { name: 'Reply' })).toBeNull();
  await act(async () => finish(Response.json({ conversation: { ...conversations[1], status: 'human' } })));
  expect(await screen.findByRole('textbox', { name: 'Reply' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
});

it('shows an optimistic reply and reconciles its SSE echo before POST without erasing a newer draft', async () => {
  let finish!: (response: Response) => void;
  let submitted!: { text: string; clientMessageId: string };
  fetcher.mockImplementation(async (input, options) => {
    if (options?.method === 'POST') {
      submitted = JSON.parse(String(options.body)) as typeof submitted;
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return reply(String(input));
  });
  mount();
  await screen.findByText('c-1 reply');
  const user = userEvent.setup();
  await user.click(screen.getByRole('option', { name: /نورة/ }));
  await screen.findByText('c-3 reply');
  const input = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;
  await user.type(input, 'Hello مرحباً');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  const history = within(screen.getByLabelText('Message history'));
  expect(await history.findByText('Hello مرحباً')).toBeTruthy();
  expect(history.getByText('Sending…')).toBeTruthy();
  expect(input.value).toBe('');
  await user.type(input, 'Next draft');
  const confirmed: Message = {
    id: 'human-1',
    conversationId: 'c-3',
    role: 'human',
    text: submitted.text,
    clientMessageId: submitted.clientMessageId,
    createdAt: '2026-11-23T13:00:00.000Z',
  };
  act(() =>
    FakeEventSource.instances[0]!.send({ id: 5, type: 'message', conversationId: 'c-3', message: confirmed }),
  );
  await waitFor(() => expect(history.queryByText('Sending…')).toBeNull());
  await act(async () => finish(Response.json({ message: confirmed }, { status: 201 })));
  expect(history.getAllByText('Hello مرحباً')).toHaveLength(1);
  expect(input.value).toBe('Next draft');
});

it('marks the rejected bubble in place and retries there while preserving a newer draft and live messages', async () => {
  let rejectFirst!: (response: Response) => void;
  const submissions: { text: string; clientMessageId: string }[] = [];
  fetcher.mockImplementation(async (input, options) => {
    if (options?.method === 'POST') {
      const submitted = JSON.parse(String(options.body)) as { text: string; clientMessageId: string };
      submissions.push(submitted);
      if (submissions.length === 1)
        return new Promise<Response>((resolve) => {
          rejectFirst = resolve;
        });
      return Response.json(
        {
          message: {
            ...submitted,
            id: 'human-retry',
            conversationId: 'c-3',
            role: 'human',
            createdAt: '2026-11-23T13:01:00.000Z',
          },
        },
        { status: 201 },
      );
    }
    return reply(String(input));
  });
  mount();
  await screen.findByText('c-1 reply');
  const user = userEvent.setup();
  await user.click(screen.getByRole('option', { name: /نورة/ }));
  await screen.findByText('c-3 reply');
  const input = screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;
  await user.type(input, 'First reply');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  const history = within(screen.getByLabelText('Message history'));
  expect(await history.findByText('First reply')).toBeTruthy();
  await user.type(input, 'Later draft');
  act(() =>
    FakeEventSource.instances[0]!.send({
      id: 5,
      type: 'message',
      conversationId: 'c-3',
      message: {
        ...thread('c-3').messages[0]!,
        id: 'customer-live',
        role: 'customer',
        text: 'New customer request',
      },
    }),
  );
  await act(async () =>
    rejectFirst(Response.json({ error: 'Random failure, please retry' }, { status: 500 })),
  );
  expect(await history.findByText(copy.en.replyNotSent)).toBeTruthy();
  expect(history.getAllByText('First reply')).toHaveLength(1);
  const failedRow = history.getByText('First reply').closest('[role="listitem"]') as HTMLElement;
  expect(within(failedRow).getByText(copy.en.replyNotSent)).toBeTruthy();
  expect(within(failedRow).getByTitle('Random failure, please retry')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(history.getByText('New customer request')).toBeTruthy();
  const rows = history.getAllByRole('listitem');
  expect(rows.indexOf(failedRow)).toBeLessThan(
    rows.indexOf(history.getByText('New customer request').closest('[role="listitem"]') as HTMLElement),
  );
  expect(input.value).toBe('Later draft');
  await user.click(within(failedRow).getByRole('button', { name: copy.en.retryReply }));
  expect(await history.findByText('First reply')).toBeTruthy();
  await waitFor(() => expect(history.queryByText('Sending…')).toBeNull());
  expect(history.queryByText(copy.en.replyNotSent)).toBeNull();
  expect(history.getAllByText('First reply')).toHaveLength(1);
  expect(submissions.map(({ text }) => text)).toEqual(['First reply', 'First reply']);
  expect(input.value).toBe('Later draft');
});

it('retains multiple failed bubbles across conversation switches and retries the selected reply only', async () => {
  const submissions: { conversationId: string; text: string; clientMessageId: string }[] = [];
  fetcher.mockImplementation(async (input, options) => {
    const url = String(input);
    if (options?.method === 'POST') {
      const submitted = {
        ...(JSON.parse(String(options.body)) as { text: string; clientMessageId: string }),
        conversationId: url.split('/').at(-2)!,
      };
      submissions.push(submitted);
      if (submissions.length <= 3)
        return Response.json({ error: 'Random failure, please retry' }, { status: 500 });
      return Response.json(
        {
          message: {
            ...submitted,
            id: 'retried-first-reply',
            role: 'human',
            createdAt: '2026-11-24T13:00:00.000Z',
          },
        },
        { status: 201 },
      );
    }
    return url.endsWith('/conversations')
      ? Response.json({
          lastEventId: 4,
          conversations: conversations.map((conversation) =>
            conversation.id === 'c-1' ? { ...conversation, status: 'human' } : conversation,
          ),
        })
      : reply(url);
  });
  mount(Infinity);
  const user = userEvent.setup();
  await screen.findByText('c-1 reply');
  await user.click(screen.getByRole('option', { name: /نورة/ }));
  await screen.findByText('c-3 reply');
  const input = () => screen.getByRole('textbox', { name: copy.en.reply }) as HTMLTextAreaElement;
  const history = () => within(screen.getByLabelText(copy.en.messageHistory));

  await user.type(input(), 'First failed reply');
  await user.click(screen.getByRole('button', { name: copy.en.send }));
  await history().findByText(copy.en.replyNotSent);
  expect(input().value).toBe('');
  await user.type(input(), 'Second failed reply');
  await user.click(screen.getByRole('button', { name: copy.en.send }));
  await waitFor(() => expect(history().getAllByText(copy.en.replyNotSent)).toHaveLength(2));
  expect(history().getAllByText('First failed reply')).toHaveLength(1);
  expect(history().getAllByText('Second failed reply')).toHaveLength(1);
  expect(input().value).toBe('');

  await user.click(screen.getByRole('option', { name: /Sara/ }));
  await screen.findByText('c-1 reply');
  expect(history().queryByText('First failed reply')).toBeNull();
  await user.type(input(), 'Sara failed reply');
  await user.click(screen.getByRole('button', { name: copy.en.send }));
  await history().findByText(copy.en.replyNotSent);
  await user.type(input(), 'Sara next draft');

  await user.click(screen.getByRole('option', { name: /نورة/ }));
  await screen.findByText('c-3 reply');
  expect(history().getAllByText(copy.en.replyNotSent)).toHaveLength(2);
  expect(history().queryByText('Sara failed reply')).toBeNull();
  await user.type(input(), 'Noura next draft');
  const firstRow = history().getByText('First failed reply').closest('[role="listitem"]') as HTMLElement;
  await user.click(within(firstRow).getByRole('button', { name: copy.en.retryReply }));
  await waitFor(() => expect(history().queryByText(copy.en.sending)).toBeNull());
  await waitFor(() => expect(history().getAllByText(copy.en.replyNotSent)).toHaveLength(1));
  expect(history().getAllByText('First failed reply')).toHaveLength(1);
  const secondRow = history().getByText('Second failed reply').closest('[role="listitem"]') as HTMLElement;
  expect(within(secondRow).getByText(copy.en.replyNotSent)).toBeTruthy();
  expect(input().value).toBe('Noura next draft');
  expect(submissions.map(({ conversationId, text }) => ({ conversationId, text }))).toEqual([
    { conversationId: 'c-3', text: 'First failed reply' },
    { conversationId: 'c-3', text: 'Second failed reply' },
    { conversationId: 'c-1', text: 'Sara failed reply' },
    { conversationId: 'c-3', text: 'First failed reply' },
  ]);
  expect(submissions[3]!.clientMessageId).not.toBe(submissions[0]!.clientMessageId);

  await user.click(screen.getByRole('option', { name: /Sara/ }));
  await screen.findByText('c-1 reply');
  expect(history().getAllByText(copy.en.replyNotSent)).toHaveLength(1);
  expect(history().getByText('Sara failed reply')).toBeTruthy();
  expect(input().value).toBe('Sara next draft');
});

it('keeps drafts separate when switching between conversations', async () => {
  fetcher.mockImplementation(async (input) =>
    String(input).endsWith('/conversations')
      ? Response.json({
          lastEventId: 4,
          conversations: conversations.map((conversation) =>
            conversation.id === 'c-1' ? { ...conversation, status: 'human' } : conversation,
          ),
        })
      : reply(String(input)),
  );
  mount(Infinity);
  await screen.findByText('c-1 reply');
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'Sara draft');
  await user.click(screen.getByRole('option', { name: /نورة/ }));
  await screen.findByText('c-3 reply');
  expect((screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement).value).toBe('');
  await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'نورة draft');
  await user.click(screen.getByRole('option', { name: /Sara/ }));
  await screen.findByText('c-1 reply');
  expect((screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement).value).toBe('Sara draft');
  await user.click(screen.getByRole('option', { name: /نورة/ }));
  await screen.findByText('c-3 reply');
  expect((screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement).value).toBe('نورة draft');
});

it('keeps uncertain delivery visible and checks the snapshot without automatically resending', async () => {
  let submitted!: { text: string; clientMessageId: string };
  let confirmed: Message | undefined;
  let postCount = 0;
  fetcher.mockImplementation(async (input, options) => {
    if (options?.method === 'POST') {
      postCount++;
      submitted = JSON.parse(String(options.body)) as typeof submitted;
      throw new TypeError('Network connection lost');
    }
    if (confirmed && String(input).endsWith('/c-3/messages')) {
      return Response.json({ lastEventId: 5, messages: [...thread('c-3').messages, confirmed] });
    }
    return reply(String(input));
  });
  mount();
  await screen.findByText('c-1 reply');
  const user = userEvent.setup();
  await user.click(screen.getByRole('option', { name: /نورة/ }));
  await screen.findByText('c-3 reply');
  await user.type(screen.getByRole('textbox', { name: 'Reply' }), 'Please confirm delivery');
  await user.click(screen.getByRole('button', { name: 'Send' }));
  const history = within(screen.getByLabelText('Message history'));
  expect(await history.findByText(copy.en.deliveryUnconfirmed)).toBeTruthy();
  const uncertainRow = history.getByText('Please confirm delivery').closest('[role="listitem"]') as HTMLElement;
  expect(within(uncertainRow).getByText(copy.en.duplicateWarning)).toBeTruthy();
  expect(within(uncertainRow).getByRole('button', { name: copy.en.sendAgain })).toBeTruthy();
  expect(screen.queryByText('Delivery is unconfirmed')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  confirmed = {
    ...submitted,
    id: 'human-found',
    conversationId: 'c-3',
    role: 'human',
    createdAt: '2026-11-23T13:00:00.000Z',
  };
  await waitFor(() =>
    expect(within(uncertainRow).getByRole('button', { name: copy.en.checkDelivery }).getAttribute('aria-disabled')).not.toBe(
      'true',
    ),
  );
  await user.click(within(uncertainRow).getByRole('button', { name: copy.en.checkDelivery }));
  await waitFor(() => expect(history.queryByText(copy.en.deliveryUnconfirmed)).toBeNull());
  expect(history.queryByText(copy.en.duplicateWarning)).toBeNull();
  expect(history.getAllByText('Please confirm delivery')).toHaveLength(1);
  expect(postCount).toBe(1);
});
