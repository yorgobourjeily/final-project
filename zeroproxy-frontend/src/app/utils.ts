const pad = (n: number) => String(n).padStart(2, '0');

export const uid = () => Math.random().toString(36).slice(2, 10);

/** Local date as YYYY-MM-DD. */
export const dateKey = (d = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local time as HH:mm. */
export const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** HH:mm plus some minutes, as HH:mm. */
export const addMinutes = (hhmm: string, minutes: number) => {
  const total = (toMinutes(hhmm) + minutes) % (24 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

/** Days of the week in display order (Monday first). `n` matches Date.getDay(): 0 = Sunday … 6 = Saturday. */
export const WEEK_DAYS = [
  { n: 1, short: 'Mon', plural: 'Mondays' },
  { n: 2, short: 'Tue', plural: 'Tuesdays' },
  { n: 3, short: 'Wed', plural: 'Wednesdays' },
  { n: 4, short: 'Thu', plural: 'Thursdays' },
  { n: 5, short: 'Fri', plural: 'Fridays' },
  { n: 6, short: 'Sat', plural: 'Saturdays' },
  { n: 0, short: 'Sun', plural: 'Sundays' },
];

/** Day of the week of a YYYY-MM-DD date: 0 = Sunday … 6 = Saturday. */
export const weekdayOf = (date: string) => new Date(`${date}T12:00:00`).getDay();

/** "Mon–Fri", "Tue, Thu", "Every day". */
export function daysText(days: number[]): string {
  const ordered = WEEK_DAYS.filter((d) => days.includes(d.n));
  if (ordered.length === 7) return 'Every day';
  const weekdays = [1, 2, 3, 4, 5];
  if (ordered.length === 5 && weekdays.every((d) => days.includes(d))) return 'Mon–Fri';
  return ordered.map((d) => d.short).join(', ');
}

/** "Saturdays" for a YYYY-MM-DD date. */
export const dayPlural = (date: string) => WEEK_DAYS.find((d) => d.n === weekdayOf(date))!.plural;

/** The last `count` weekdays before today, oldest first. */
export function pastWeekdays(count: number, from = new Date()): string[] {
  const days: string[] = [];
  const d = new Date(from);
  while (days.length < count) {
    d.setDate(d.getDate() - 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) days.unshift(dateKey(d));
  }
  return days;
}
