/** Date formats from HMISMobile/lib/ui/widgets.dart, in the browser's time zone. */
const locale = 'en-GB';
const timeFmt = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
const weekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'long' });
const shortWeekdayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
const dayMonthFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
const fullDateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' });

export type When = string | number | Date;

export function toDate(t: When): Date | null {
  const d = t instanceof Date ? t : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "09:15" */
export function timeLabel(t: When): string {
  const d = toDate(t);
  return d ? timeFmt.format(d) : '';
}

/** "Mon 6 Oct" */
export function dayLabel(t: When): string {
  const d = toDate(t);
  return d ? dayFmt.format(d).replace(',', '') : 'Unknown date';
}

/** "Monday" */
export function weekdayLabel(t: When = new Date()): string {
  return weekdayFmt.format(toDate(t) ?? new Date());
}

/** "6 Oct 2026, 09:15" */
export function dateTimeLabel(t: When): string {
  const d = toDate(t);
  return d ? `${fullDateFmt.format(d)}, ${timeFmt.format(d)}` : '';
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function isSameDay(a: When, b: When = new Date()): boolean {
  const x = toDate(a);
  const y = toDate(b);
  return !!x && !!y && startOfDay(x) === startOfDay(y);
}

/** "Today 11:58", "Yesterday 17:20", "Mon 17:20", "3 Oct 09:15". */
export function shortWhen(t: When): string {
  const d = toDate(t);
  if (!d) return '';
  const days = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `Today ${timeFmt.format(d)}`;
  if (days === 1) return `Yesterday ${timeFmt.format(d)}`;
  if (days > 1 && days < 7) return `${shortWeekdayFmt.format(d)} ${timeFmt.format(d)}`;
  return `${dayMonthFmt.format(d)} ${timeFmt.format(d)}`;
}

/** "just now", "5 min ago", "2 hours ago", "3 days ago". */
export function ago(t: When): string {
  const d = toDate(t);
  if (!d) return '';
  const minutes = Math.floor((Date.now() - d.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
