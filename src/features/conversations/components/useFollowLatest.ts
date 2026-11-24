import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Message } from '../../../domain/conversation';

const messageKeys = (message: Message) => {
  const clientId = message.clientMessageId;
  return clientId ? [message.id, clientId] : [message.id];
};

export function useFollowLatest(
  messages: Message[],
  scrollElement: HTMLDivElement | null,
  scrollToLatest: (behavior?: ScrollBehavior) => void,
  cancelScroll: () => void,
) {
  const following = useRef(true);
  const jumping = useRef(false);
  const seen = useRef(new Set<string>());
  const [away, setAway] = useState(false);
  const [newCount, setNewCount] = useState(0);

  useLayoutEffect(() => {
    if (following.current && !jumping.current) {
      seen.current = new Set(messages.flatMap(messageKeys));
      scrollToLatest();
    }
    setNewCount(
      messages.filter((message) => {
        const keys = messageKeys(message);
        if (!keys.some((key) => seen.current.has(key))) return true;
        // Retrying keeps the local row ID; confirmation keeps the request correlation ID.
        keys.forEach((key) => seen.current.add(key));
        return false;
      }).length,
    );
  }, [messages, scrollElement, scrollToLatest]);

  const onScroll = useCallback(() => {
    if (!scrollElement) return;
    const remaining = scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
    // Let the virtualizer finish its smooth scroll before following live updates.
    if (jumping.current && remaining > 1) return;
    jumping.current = false;
    const wasFollowing = following.current;
    following.current = remaining < 80;
    setAway(!following.current);
    if (following.current) {
      // History changes are handled by the layout effect; scrolling only marks a return as seen.
      if (!wasFollowing) seen.current = new Set(messages.flatMap(messageKeys));
      setNewCount(0);
    }
  }, [messages, scrollElement]);

  useEffect(() => {
    if (!scrollElement) return;
    const onUserScroll = (event: Event) => {
      if (
        event instanceof KeyboardEvent &&
        !['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)
      )
        return;
      if (!jumping.current) return;
      jumping.current = false;
      cancelScroll();
      onScroll();
    };
    const observer = new ResizeObserver(() => {
      if (jumping.current) {
        onScroll();
        return;
      }
      if (following.current) scrollToLatest();
      else onScroll();
    });
    observer.observe(scrollElement);
    if (scrollElement.firstElementChild) observer.observe(scrollElement.firstElementChild);
    scrollElement.addEventListener('scroll', onScroll, { passive: true });
    scrollElement.addEventListener('wheel', onUserScroll, { passive: true });
    scrollElement.addEventListener('touchstart', onUserScroll, { passive: true });
    scrollElement.addEventListener('keydown', onUserScroll);
    return () => {
      observer.disconnect();
      scrollElement.removeEventListener('scroll', onScroll);
      scrollElement.removeEventListener('wheel', onUserScroll);
      scrollElement.removeEventListener('touchstart', onUserScroll);
      scrollElement.removeEventListener('keydown', onUserScroll);
    };
  }, [cancelScroll, onScroll, scrollElement, scrollToLatest]);

  const jumpToLatest = useCallback(() => {
    following.current = false;
    jumping.current = true;
    seen.current = new Set(messages.flatMap(messageKeys));
    setAway(false);
    setNewCount(0);
    // Keep keyboard focus in the history when its jump button disappears.
    scrollElement?.focus({ preventScroll: true });
    scrollToLatest(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
    onScroll();
  }, [messages, onScroll, scrollElement, scrollToLatest]);

  return { away, newCount, jumpToLatest };
}
