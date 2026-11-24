import { Button, Spinner, Surface, Typography } from '@heroui/react';
import { ChatCircleDotsIcon, WarningCircleIcon } from '@phosphor-icons/react';
import { useTranslation } from '../../../i18n/useTranslation';

type Props = { title: string; loading?: boolean; onRetry?: () => void };

export function RequestState({ title, loading, onRetry }: Props) {
  const { text } = useTranslation();
  return (
    <Surface
      variant="transparent"
      role={onRetry ? 'alert' : 'status'}
      className="flex flex-col items-center gap-2 py-4 text-center"
    >
      {loading ? (
        <Spinner aria-label={title} />
      ) : onRetry ? (
        <WarningCircleIcon aria-hidden="true" size={24} className="text-danger" />
      ) : (
        <ChatCircleDotsIcon aria-hidden="true" size={24} className="text-muted" />
      )}
      <Typography type="body-sm" color="muted" align="center">
        {title}
      </Typography>
      {onRetry ? (
        <Button variant="secondary" size="sm" onPress={onRetry}>
          {text.tryAgain}
        </Button>
      ) : null}
    </Surface>
  );
}
