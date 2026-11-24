import { Chip } from '@heroui/react';
import { CheckCircleIcon, HeadsetIcon, RobotIcon, UserCircleIcon } from '@phosphor-icons/react';
import type { Conversation } from '../../../domain/conversation';
import { useTranslation } from '../../../i18n/useTranslation';

const statuses = {
  ai: { color: 'default', Icon: RobotIcon },
  needs_human: { color: 'warning', Icon: HeadsetIcon },
  human: { color: 'success', Icon: UserCircleIcon },
  closed: { color: 'default', Icon: CheckCircleIcon },
} as const;

export function StatusChip({ status }: { status: Conversation['status'] }) {
  const { text } = useTranslation();
  const { color, Icon } = statuses[status];
  return (
    <Chip color={color} variant="soft" size="sm">
      <Icon aria-hidden="true" size={14} />
      <Chip.Label>{text.statuses[status]}</Chip.Label>
    </Chip>
  );
}
