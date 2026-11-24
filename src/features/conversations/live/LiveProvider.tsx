import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createConversationLive } from './controller';

const LiveContext = createContext<ReturnType<typeof createConversationLive> | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [live] = useState(() => createConversationLive(queryClient));
  useEffect(() => {
    live.start();
    return () => live.stop();
  }, [live]);
  return <LiveContext value={live}>{children}</LiveContext>;
}

export function useConversationLive() {
  const live = useContext(LiveContext);
  if (!live) throw new Error('Conversation components require LiveProvider.');
  return live;
}
