import { createStore } from 'zustand/vanilla';
import type { Message } from '../../../domain/conversation';
import type { ConnectionStatus } from './connection';

export type ReplyAttempt = {
  message: Message;
  afterMessageId?: string | null;
  order: number;
  status: 'sending' | 'failed' | 'uncertain';
  error?: string;
  checking?: boolean;
};

type LiveState = {
  connection: ConnectionStatus;
  streams: Record<string, Message>;
  handoffs: Record<string, string>;
  drafts: Record<string, string>;
  sends: Record<string, ReplyAttempt>;
  failedReplies: Record<string, ReplyAttempt[]>;
  takeovers: Record<string, { pending: boolean; error?: string }>;
};

export const createLiveStore = () =>
  createStore<LiveState>(() => ({
    connection: 'connecting',
    streams: {},
    handoffs: {},
    drafts: {},
    sends: {},
    failedReplies: {},
    takeovers: {},
  }));
