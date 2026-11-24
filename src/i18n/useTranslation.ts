import { useLocale } from '@heroui/react';
import { formatters, messages, type Locale } from './messages';

export function useTranslation() {
  const { locale: language } = useLocale();
  const locale: Locale = language.split('-')[0] === 'ar' ? 'ar' : 'en';
  return { text: messages[locale], locale, format: formatters[locale] };
}
