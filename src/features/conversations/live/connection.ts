import { apiBaseUrl } from '../../../api/config';
import { eventSchema } from './events';
import type { LiveEvent } from './events';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

type Options = {
  getCursor: () => number;
  onEvent: (event: LiveEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
};

export function connectEvents({ getCursor, onEvent, onStatus }: Options): () => void {
  let source: EventSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  function retry(status: 'disconnected' | 'error') {
    source?.close();
    source = null;
    onStatus(status);
    if (timer === undefined && !stopped) {
      timer = setTimeout(() => {
        timer = undefined;
        open('reconnecting');
      }, 3000);
    }
  }

  function open(status: 'connecting' | 'reconnecting') {
    if (stopped) return;
    onStatus(status);
    let current: EventSource;
    try {
      current = new EventSource(`${apiBaseUrl}/events?since=${getCursor()}`);
      source = current;
    } catch {
      retry('error');
      return;
    }
    const isCurrent = () => !stopped && source === current;
    current.onopen = () => { if (isCurrent()) onStatus('connected'); };
    current.onerror = () => { if (isCurrent()) retry('disconnected'); };
    current.onmessage = (message) => {
      if (!isCurrent()) return;
      let event: LiveEvent;
      try {
        event = eventSchema.parse(JSON.parse(message.data));
        if (message.lastEventId && message.lastEventId !== String(event.id)) {
          throw new Error('Event frame ID does not match its payload.');
        }
        if (event.id > getCursor() + 1) {
          throw new Error('An event is missing before this event.');
        }
      } catch {
        retry('error');
        return;
      }
      onEvent(event);
    };
  }

  open('connecting');
  return () => {
    stopped = true;
    source?.close();
    source = null;
    clearTimeout(timer);
    timer = undefined;
  };
}
