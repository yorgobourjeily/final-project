import { ChangeDetectionStrategy, Component, computed, input, model, output } from '@angular/core';
import { User } from '../../models';

let nextId = 0;

/**
 * Search box for students by ID: type digits, pick from the matches.
 * - `value` is the typed text (two-way bindable).
 * - `picked` fires when a student is chosen (click, or Enter for the first match).
 * - With `clearOnPick`, the box empties after each pick (to add several students in a row).
 */
@Component({
  selector: 'app-student-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './student-search.html',
  styleUrl: './student-search.css',
  host: { '[class.inline]': '!floating()' },
})
export class StudentSearch {
  readonly students = input.required<User[]>();
  readonly value = model('');
  readonly label = input('');
  readonly ariaLabel = input('');
  readonly placeholder = input('e.g. 2');
  readonly clearOnPick = input(false);
  /** Dropdown floats over the page; turn off inside scrolling tables so it isn't cut off. */
  readonly floating = input(true);
  readonly picked = output<User>();

  protected readonly inputId = `student-search-${++nextId}`;
  protected readonly listId = `${this.inputId}-list`;

  protected readonly typed = computed(() => this.value().trim());

  /** The student whose ID is typed in exactly. */
  protected readonly exact = computed(() => this.students().find((s) => s.studentNumber === this.typed()));

  protected readonly matches = computed(() => {
    const typed = this.typed();
    if (!typed || (this.exact() && !this.clearOnPick())) return [];
    return this.students()
      .filter((s) => s.studentNumber?.includes(typed))
      .sort((a, b) => (a.studentNumber ?? '').localeCompare(b.studentNumber ?? ''))
      .slice(0, 8);
  });

  protected onInput(event: Event) {
    this.value.set((event.target as HTMLInputElement).value);
  }

  protected pick(student: User) {
    this.value.set(this.clearOnPick() ? '' : (student.studentNumber ?? ''));
    this.picked.emit(student);
  }

  protected pickFirst(event: Event) {
    const first = this.matches()[0];
    if (!first) return;
    event.preventDefault();
    this.pick(first);
  }
}
