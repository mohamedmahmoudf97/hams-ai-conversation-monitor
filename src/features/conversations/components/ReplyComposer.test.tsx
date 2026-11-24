// @vitest-environment jsdom
import { I18nProvider } from '@heroui/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation } from '../../../domain/conversation';
import { messages as copy } from '../../../i18n/messages';
import { useTranslation } from '../../../i18n/useTranslation';
import { createLiveStore } from '../live/store';
import { ReplyComposer } from './ReplyComposer';

vi.mock('../../../i18n/useTranslation', { spy: true });

let store: ReturnType<typeof createLiveStore>;
const sendReply = vi.fn();
vi.mock('../live/LiveProvider', () => ({
  useConversationLive: () => ({
    store,
    sendReply,
    setDraft: (id: string, text: string) =>
      store.setState((state) => ({ drafts: { ...state.drafts, [id]: text } })),
  }),
}));

const conversation: Conversation = {
  id: 'c-1',
  customer: 'Sara',
  status: 'human',
  lastMessage: '',
  unread: 0,
  updatedAt: '2026-11-24T12:00:00.000Z',
};
const input = () => screen.getByRole('textbox', { name: 'Reply' }) as HTMLTextAreaElement;
const mount = (historyLoaded = true) =>
  render(
    <ReplyComposer
      conversationId={conversation.id}
      status={conversation.status}
      historyLoaded={historyLoaded}
    />,
  );

beforeEach(() => {
  store = createLiveStore();
  store.setState({ drafts: { 'c-1': 'Hello' } });
  sendReply.mockReset();
});
afterEach(cleanup);

it('sends with Enter without inserting a newline or moving focus', async () => {
  mount();
  const user = userEvent.setup();
  await user.click(input());
  await user.keyboard('{Enter}');
  expect(sendReply).toHaveBeenCalledExactlyOnceWith('c-1');
  expect(input().value).toBe('Hello');
  expect(document.activeElement).toBe(input());
});

it('keeps Shift+Enter as a newline for mixed-language replies', async () => {
  mount();
  const user = userEvent.setup();
  await user.click(input());
  await user.keyboard('{Shift>}{Enter}{/Shift}مرحباً Premium');
  expect(input().value).toBe('Hello\nمرحباً Premium');
  expect(sendReply).not.toHaveBeenCalled();
});

it.each([{ isComposing: true }, { keyCode: 229 }])(
  'does not send while an IME is committing text: %j',
  (native) => {
    mount();
    fireEvent.keyDown(input(), { key: 'Enter', code: 'Enter', ...native });
    expect(sendReply).not.toHaveBeenCalled();
  },
);

it('ignores held Enter key repeats', () => {
  mount();
  fireEvent.keyDown(input(), { key: 'Enter' });
  fireEvent.keyDown(input(), { key: 'Enter', repeat: true });
  expect(sendReply).toHaveBeenCalledTimes(1);
});

it.each(['sending', 'uncertain'] as const)(
  'blocks Enter and form submission while delivery is %s',
  (status) => {
    store.setState({
      sends: {
        'c-1': {
          status,
          order: 1,
          message: {
            id: 'pending-1',
            conversationId: 'c-1',
            role: 'human',
            text: 'Previous reply',
            createdAt: conversation.updatedAt,
            clientMessageId: 'attempt-1',
          },
        },
      },
    });
    mount();
    fireEvent.keyDown(input(), { key: 'Enter' });
    fireEvent.submit(input().form!);
    expect(sendReply).not.toHaveBeenCalled();
  },
);

it.each([
  { draft: '   \n ', loaded: true },
  { draft: 'Hello', loaded: false },
])('blocks submission for empty drafts or unloaded history: %j', ({ draft, loaded }) => {
  store.setState({ drafts: { 'c-1': draft } });
  mount(loaded);
  fireEvent.keyDown(input(), { key: 'Enter' });
  fireEvent.submit(input().form!);
  expect(sendReply).not.toHaveBeenCalled();
});

it('uses the same send action when clicking Send', async () => {
  mount();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Send' }));
  expect(sendReply).toHaveBeenCalledExactlyOnceWith('c-1');
});

it.each(['failed', 'uncertain'] as const)(
  'keeps %s delivery feedback out of the composer and leaves the current draft intact',
  (status) => {
    store.setState({
      sends: {
        'c-1': {
          status,
          order: 1,
          error: 'Delivery error',
          message: {
            id: 'pending-1',
            conversationId: 'c-1',
            role: 'human',
            text: 'Previous reply',
            createdAt: conversation.updatedAt,
            clientMessageId: 'attempt-1',
          },
        },
      },
    });
    mount();
    expect(input().value).toBe('Hello');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('Delivery error')).toBeNull();
    expect(screen.queryByText('Previous reply')).toBeNull();
    expect(screen.queryByRole('button', { name: copy.en.retryReply })).toBeNull();
    expect(screen.queryByRole('button', { name: copy.en.checkDelivery })).toBeNull();
    expect((screen.getByRole('button', { name: copy.en.send }) as HTMLButtonElement).disabled).toBe(
      status === 'uncertain',
    );
  },
);

it('skips unchanged parent renders while draft, locale, and status updates still work', () => {
  const view = (locale: string, status: Conversation['status'] = 'human') => (
    <I18nProvider locale={locale}>
      <ReplyComposer conversationId="c-1" status={status} historyLoaded />
    </I18nProvider>
  );
  const { rerender } = render(view('en'));
  vi.mocked(useTranslation).mockClear();
  rerender(view('en'));
  expect(useTranslation).not.toHaveBeenCalled();

  fireEvent.change(input(), { target: { value: 'Hello مرحباً' } });
  expect(useTranslation).toHaveBeenCalled();
  expect(input().value).toBe('Hello مرحباً');
  expect(store.getState().drafts['c-1']).toBe('Hello مرحباً');

  rerender(view('ar'));
  expect((screen.getByRole('textbox', { name: copy.ar.reply }) as HTMLTextAreaElement).value).toBe(
    'Hello مرحباً',
  );
  expect(screen.getByRole('button', { name: copy.ar.send })).toBeTruthy();
  rerender(view('ar', 'closed'));
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(store.getState().drafts['c-1']).toBe('Hello مرحباً');
});
