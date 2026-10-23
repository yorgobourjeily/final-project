import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { DataService } from '../../../data.service';
import { DayOff, SchoolClass } from '../../../models';
import { dateKey } from '../../../utils';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

interface Lesson {
  schoolClass: SchoolClass;
  cancelled: boolean;
}

interface DayCell {
  date: string;
  day: number;
  off?: DayOff;
  /** Whether at least one of the teacher's classes takes place that day (not a day off, not cancelled). */
  hasClass: boolean;
  isToday: boolean;
}

/** Teacher calendar: which of the teacher's classes meet on each day, and at what time. Read only. */
@Component({
  selector: 'app-teacher-calendar',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './teacher-calendar.html',
  styleUrl: './teacher-calendar.css',
})
export class TeacherCalendar {
  protected readonly data = inject(DataService);
  readonly classes = input.required<SchoolClass[]>();

  protected readonly today = dateKey();
  protected readonly months = MONTHS;
  protected readonly weekdayHeaders = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  protected readonly year = signal(new Date().getFullYear());
  /** 0 = January … 11 = December. */
  protected readonly month = signal(new Date().getMonth());
  protected readonly selected = signal(this.today);

  /** A few years around now, plus the year shown. */
  protected readonly years = computed(() => {
    const now = new Date().getFullYear();
    const list = [now - 1, now, now + 1, now + 2];
    if (!list.includes(this.year())) list.push(this.year());
    return list.sort((a, b) => a - b);
  });

  /** The teacher's classes meeting on a date (by their weekdays), earliest first. */
  private lessonsOn(date: string): Lesson[] {
    return this.classes()
      .filter((c) => this.data.meetsOn(c, date))
      .sort(
        (a, b) =>
          a.startTime.localeCompare(b.startTime) ||
          a.endTime.localeCompare(b.endTime) ||
          a.name.localeCompare(b.name, undefined, { numeric: true }),
      )
      .map((schoolClass) => ({ schoolClass, cancelled: !!this.data.cancellation(schoolClass.id, date) }));
  }

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
      const off = this.data.dayOff(date);
      cells.push({
        date,
        day,
        off,
        hasClass: !off && this.lessonsOn(date).some((l) => !l.cancelled),
        isToday: date === this.today,
      });
    }
    while (cells.length % 7) cells.push(null);

    const weeks: (DayCell | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  });

  protected readonly selectedOff = computed(() => this.data.dayOff(this.selected()));
  protected readonly selectedLessons = computed(() =>
    this.lessonsOn(this.selected()).map((l) => ({ ...l, students: this.data.studentsIn(l.schoolClass.id).length })),
  );

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
    this.selected.set(this.today);
  }
}
