import { Button, ButtonGroup } from '@heroui/react';
import type { Locale } from '../i18n/messages';
import { useTranslation } from '../i18n/useTranslation';

export function LanguageControls({
  locale,
  onChange,
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
}) {
  const { text } = useTranslation();
  return (
    <ButtonGroup
      aria-label={text.language}
      size="sm"
      variant="secondary"
      className="col-start-2 row-start-1 sm:ms-auto"
    >
      <Button
        lang="en"
        aria-label="En — English"
        aria-pressed={locale === 'en'}
        variant={locale === 'en' ? 'primary' : 'secondary'}
        onPress={() => onChange('en')}
      >
        En
      </Button>
      <Button
        lang="ar"
        aria-label="Ar — العربية"
        aria-pressed={locale === 'ar'}
        variant={locale === 'ar' ? 'primary' : 'secondary'}
        onPress={() => onChange('ar')}
      >
        Ar
      </Button>
    </ButtonGroup>
  );
}
