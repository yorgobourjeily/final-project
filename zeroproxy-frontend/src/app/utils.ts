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
