import { useEffect, useRef, useState } from 'react';
import { Toast, ToastQueue, type ToastContentValue } from '@heroui/react';
import { WifiHighIcon, WifiSlashIcon } from '@phosphor-icons/react';
import { useStore } from 'zustand';
import { useTranslation } from '../../../i18n/useTranslation';
import { useConversationLive } from '../live/LiveProvider';

export function ConnectionToast() {
  const { text } = useTranslation();
  const live = useConversationLive();
  const status = useStore(live.store, (state) => state.connection);
  const [queue] = useState(() => new ToastQueue({ maxVisibleToasts: 1 }));
  const toastId = useRef<string | undefined>(undefined);
  const previousStatus = useRef(status);

  useEffect(
    () => () => {
      queue.destroy();
      toastId.current = undefined;
    },
    [queue],
  );

  useEffect(() => {
    const statusChanged = previousStatus.current !== status;
    previousStatus.current = status;
    if (!toastId.current && (status === 'connecting' || status === 'connected')) return;
    const connected = status === 'connected';
    const content: ToastContentValue = {
      title: text.connections[status],
      variant: connected ? 'success' : status === 'error' ? 'danger' : 'warning',
      isLoading: status === 'connecting' || status === 'reconnecting',
      indicator: connected ? <WifiHighIcon aria-hidden="true" /> : <WifiSlashIcon aria-hidden="true" />,
    };
    const options = {
      ...(statusChanged ? { timeout: connected ? 4000 : 0 } : {}),
      onClose: () => {
        toastId.current = undefined;
      },
    };
    if (!toastId.current || !queue.update(toastId.current, content, options)) {
      toastId.current = queue.add(content, options);
    }
  }, [queue, status, text]);

  return <Toast.Provider queue={queue} placement="bottom" aria-label={text.connectionNotifications} />;
}
