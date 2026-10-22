import { randomUUID } from 'node:crypto';

const pad = (n: number) => String(n).padStart(2, '0');

export const newId = () => randomUUID();

/** Local date as YYYY-MM-DD. */
export const dateKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Local time as HH:mm. */
export const clock = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const addMinutes = (hhmm: string, minutes: number) => {
  const total = (toMinutes(hhmm) + minutes) % (24 * 60);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
};

export const isTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

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

/** A route parameter as a single string (Express types allow string[] too). */
export const param = (value: string | string[]) => (Array.isArray(value) ? value[0] : value);

/** An error that becomes an HTTP response with this status and message. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
