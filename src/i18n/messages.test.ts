import { describe, expect, it } from 'vitest';
import { formatters, messages, translateError } from './messages';

const arabicNumber = new Intl.NumberFormat('ar');

describe('localized message counts', () => {
  it.each([
    [0, 'لا رسائل'],
    [1, 'رسالة واحدة'],
    [2, 'رسالتان'],
    [3, `${arabicNumber.format(3)} رسائل`],
    [11, `${arabicNumber.format(11)} رسالة`],
    [100, `${arabicNumber.format(100)} رسالة`],
  ])('uses the Arabic plural form for %i', (count, expected) => {
    expect(messages.ar.messageCount(count)).toBe(expected);
  });

  it('formats English singular, plural and grouped numbers', () => {
    expect(messages.en.messageCount(1)).toBe('1 message');
    expect(messages.en.messageCount(1234)).toBe('1,234 messages');
    expect(messages.en.newMessageCount(2)).toBe('2 new messages');
  });

  it('uses the selected locale for numbers and timestamps', () => {
    expect(formatters.ar.number.format(1234)).toBe(arabicNumber.format(1234));
    for (const locale of ['en', 'ar'] as const) {
      expect(formatters[locale].number.resolvedOptions().locale).toBe(locale);
      expect(formatters[locale].time.resolvedOptions().locale).toBe(locale);
      expect(formatters[locale].dateTime.resolvedOptions().locale).toBe(locale);
    }
  });

  it('translates known app errors while preserving server details', () => {
    const error = 'The server restarted. Review and retry your reply.';
    expect(translateError(error, 'ar')).toBe('أُعيد تشغيل الخادم. راجع ردّك وأعد إرساله.');
    expect(translateError(error, 'en')).toBe(error);
    expect(translateError('Server supplied error', 'ar')).toBe('Server supplied error');
    expect(translateError('toString', 'ar')).toBe('toString');
    expect(translateError(undefined, 'ar')).toBeUndefined();
  });
});
