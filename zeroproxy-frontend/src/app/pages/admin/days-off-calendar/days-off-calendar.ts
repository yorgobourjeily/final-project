import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DataService } from '../../../data.service';
import { DayOff } from '../../../models';
import { dateKey } from '../../../utils';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface DayCell {
  date: string;
  day: number;
  off?: DayOff;
  /** How many classes are cancelled that day. */
  cancelled: number;
  weekend: boolean;
  isToday: boolean;
}

/** Admin calendar: pick a year, month and day, and mark it as a school-wide day off (no class, no attendance). */
@Component({
  selector: 'app-days-off-calendar',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './days-off-calendar.html',
  styleUrl: './days-off-calendar.css',
})
export class DaysOffCalendar {
  protected readonly data = inject(DataService);
  protected readonly today = dateKey();
  protected readonly months = MONTHS;
  protected readonly weekdayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  protected readonly year = signal(new Date().getFullYear());
  /** 0 = January … 11 = December. */
  protected readonly month = signal(new Date().getMonth());
  protected readonly selected = signal<string | null>(null);
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly error = signal('');

  /** A few years around now, plus the year shown. */
  protected readonly years = computed(() => {
    const now = new Date().getFullYear();
    const list = [now - 1, now, now + 1, now + 2];
    if (!list.includes(this.year())) list.push(this.year());
    return list.sort((a, b) => a - b);
  });

  /** The month as weeks of 7 cells (Monday first); empty cells are null. */
  protected readonly weeks = computed(() => {
    const year = this.year();
    const month = this.month();
    const pad = (n: number) => String(n).padStart(2, '0');
    const offset = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const cells: (DayCell | null)[] = Array(offset).fill(null);
    for (let day = 1; day <= daysInMonth; day++) {
      const date = `${year}-${pad(month + 1)}-${pad(day)}`;
      const weekday = new Date(year, month, day).getDay();
      cells.push({
        date,
        day,
        off: this.data.dayOff(date),
        cancelled: this.data.cancellations().filter((c) => c.date === date).length,
        weekend: weekday === 0 || weekday === 6,
        isToday: date === this.today,
      });
    }
    while (cells.length % 7) cells.push(null);

    const weeks: (DayCell | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  });

  protected readonly selectedOff = computed(() => {
    const date = this.selected();
    return date ? this.data.dayOff(date) : undefined;
  });

  protected readonly upcoming = computed(() => this.data.daysOff().filter((d) => d.date >= this.today));

  /** The classes scheduled on the selected date (by their weekdays), earliest first. */
  protected readonly dayClasses = computed(() => {
    const date = this.selected();
    if (!date) return [];
    return this.data
      .classes()
      .filter((c) => this.data.meetsOn(c, date))
      .sort((a, b) => a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name))
      .map((schoolClass) => ({
        schoolClass,
        teachers: schoolClass.teacherIds.map((id) => this.data.user(id)?.name).filter(Boolean).join(', '),
        students: this.data.studentsIn(schoolClass.id).length,
        cancelled: !!this.data.cancellation(schoolClass.id, date),
      }));
  });

  /** Search text for the day's classes: class name or teacher name. */
  protected readonly classSearch = signal('');

  /** The day's classes matching the search. */
  protected readonly shownClasses = computed(() => {
    const q = this.classSearch().trim().toLowerCase();
    if (!q) return this.dayClasses();
    return this.dayClasses().filter((k) => k.schoolClass.name.toLowerCase().includes(q) || k.teachers.toLowerCase().includes(q));
  });

  protected onClassSearch(event: Event) {
    this.classSearch.set((event.target as HTMLInputElement).value);
  }

  /** The class whose Cancel button was clicked once (waiting for confirmation). */
  protected readonly pendingCancel = signal<string | null>(null);

  protected async cancelClass(classId: string, name: string) {
    const date = this.selected();
    if (!date) return;
    this.pendingCancel.set(null);
    await this.run(this.data.setClassCancelled(classId, date, true), `${name} is cancelled on ${date}. No attendance will be taken for it.`);
  }

  protected async restoreClass(classId: string, name: string) {
    const date = this.selected();
    if (!date) return;
    await this.run(this.data.setClassCancelled(classId, date, false), `${name} on ${date} is back on.`);
  }

  protected onYear(event: Event) {
    this.year.set(Number((event.target as HTMLSelectElement).value));
  }

  protected onMonth(event: Event) {
    this.month.set(Number((event.target as HTMLSelectElement).value));
  }

  protected step(months: number) {
    const d = new Date(this.year(), this.month() + months, 1);
    this.year.set(d.getFullYear());
    this.month.set(d.getMonth());
  }

  protected goToday() {
    const now = new Date();
    this.year.set(now.getFullYear());
    this.month.set(now.getMonth());
    this.select(this.today);
  }

  protected select(date: string) {
    this.selected.set(date);
    this.pendingCancel.set(null);
    this.reason.set(this.data.dayOff(date)?.reason ?? '');
    this.message.set('');
    this.error.set('');
  }

  /** Jumps the calendar to a day off from the list and selects it. */
  protected show(date: string) {
    const [y, m] = date.split('-').map(Number);
    this.year.set(y);
    this.month.set(m - 1);
    this.select(date);
  }

  protected onReason(event: Event) {
    this.reason.set((event.target as HTMLInputElement).value);
  }

  protected async markOff() {
    const date = this.selected();
    if (!date) return;
    await this.run(this.data.setDayOff(date, this.reason().trim()), `${date} is now a day off. No attendance will be taken.`);
  }

  protected async removeOff(date = this.selected()) {
    if (!date) return;
    await this.run(this.data.removeDayOff(date), `${date} is a normal school day again.`);
    if (date === this.selected()) this.reason.set('');
  }

  private async run(action: Promise<string | null>, success: string) {
    this.busy.set(true);
    const error = await action;
    this.busy.set(false);
    this.error.set(error ?? '');
    this.message.set(error ? '' : success);
  }
}
