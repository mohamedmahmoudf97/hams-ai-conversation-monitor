import { z } from 'zod';
import { conversationStatusSchema, messageSchema } from '../../../domain/conversation';

const base = {
  id: z.number().int().positive(),
  conversationId: z.string().min(1),
};
const messageId = z.string().min(1);

export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('message_start'), messageId, role: z.literal('ai') }),
  z.object({ ...base, type: z.literal('token'), messageId, text: z.string() }),
  z.object({ ...base, type: z.literal('message_end'), messageId }),
  z.object({ ...base, type: z.literal('message'), message: messageSchema }),
  z.object({ ...base, type: z.literal('status'), status: conversationStatusSchema }),
  z.object({
    ...base,
    type: z.literal('tool_call'),
    name: z.literal('transfer_to_human'),
    args: z.object({ reason: z.string() }),
  }),
]).refine((event) => event.type !== 'message' || event.message.conversationId === event.conversationId, {
  message: 'Message belongs to another conversation.',
});

export type LiveEvent = z.infer<typeof eventSchema>;
