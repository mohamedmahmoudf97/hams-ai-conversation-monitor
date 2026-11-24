import { z } from 'zod';

export const conversationStatusSchema = z.enum(['ai', 'needs_human', 'human', 'closed']);

const conversationSchema = z.object({
  id: z.string(),
  customer: z.string(),
  status: conversationStatusSchema,
  lastMessage: z.string(),
  unread: z.number().int().nonnegative(),
  updatedAt: z.string(),
});

export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['customer', 'ai', 'human']),
  text: z.string(),
  createdAt: z.iso.datetime(),
  streaming: z.boolean().optional(),
  clientMessageId: z.string().optional(),
});

export const conversationsResponseSchema = z.object({
  lastEventId: z.number().int().nonnegative(),
  conversations: z.array(conversationSchema),
});

export const messagesResponseSchema = z.object({
  lastEventId: z.number().int().nonnegative(),
  messages: z.array(messageSchema),
});

export const takeoverResponseSchema = z.object({
  conversation: conversationSchema.extend({ status: z.literal('human') }),
});

export const sendMessageResponseSchema = z.object({
  message: messageSchema.extend({ role: z.literal('human'), clientMessageId: z.string() }),
});

export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type ConversationsResponse = z.infer<typeof conversationsResponseSchema>;
export type MessagesResponse = z.infer<typeof messagesResponseSchema>;
