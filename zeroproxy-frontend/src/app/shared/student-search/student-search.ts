import { ChangeDetectionStrategy, Component, computed, input, model, output, signal } from '@angular/core';
import { User } from '../../models';

let nextId = 0;

/**
 * Searchable dropdown of accounts by ID (students "2", teachers "t1", …).
 * Click the box to see everyone; type to narrow the list; pick with a click or Enter.
 * - `people` are the accounts that can be picked (e.g. students not in a class yet, or teachers).
 * - `value` is the typed text (two-way bindable).
 * - `picked` fires when someone is chosen.
 * - With `clearOnPick`, the box empties after each pick (to add several in a row).
 */
@Component({
  selector: 'app-student-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './student-search.html',
  styleUrl: './student-search.css',
  host: { '[class.inline]': '!floating()' },
})
export class StudentSearch {
  readonly people = input.required<User[]>();
  readonly value = model('');
  readonly label = input('');
  readonly ariaLabel = input('');
  readonly placeholder = input('e.g. 2');
  readonly clearOnPick = input(false);
  /** Show the number keypad on phones (student IDs are digits only). */
  readonly numeric = input(true);
  /** Dropdown floats over the page; turn off inside scrolling tables so it isn't cut off. */
  readonly floating = input(true);
  readonly picked = output<User>();

  protected readonly inputId = `student-search-${++nextId}`;
  protected readonly listId = `${this.inputId}-list`;

  /** Whether the dropdown list is open. */
  protected readonly open = signal(false);
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly typed = computed(() => this.value().trim().toLowerCase());

  /** The account whose ID is typed in exactly. */
  protected readonly exact = computed(() => this.people().find((p) => p.loginId === this.typed()));

  /** Everyone whose ID contains what is typed (everyone when nothing is typed), in ID order. */
  protected readonly matches = computed(() => {
    if (!this.open()) return [];
    const typed = this.typed();
    return this.people()
      .filter((p) => !typed || p.loginId.includes(typed))
      .sort((a, b) => a.loginId.localeCompare(b.loginId, undefined, { numeric: true }))
      .slice(0, 50);
  });

  protected onInput(event: Event) {
    this.value.set((event.target as HTMLInputElement).value);
    this.open.set(true);
  }

  protected onFocus() {
    clearTimeout(this.closeTimer);
    this.open.set(true);
  }

  /** Closes a moment after leaving the box, so a click on a list item still counts. */
  protected onBlur() {
    this.closeTimer = setTimeout(() => this.open.set(false), 150);
  }

  protected pick(person: User) {
    this.value.set(this.clearOnPick() ? '' : person.loginId);
    this.open.set(false);
    this.picked.emit(person);
  }

  protected onEnter(event: Event) {
    if (!this.open()) return;
    // Enter picks the exact ID typed, otherwise the first match.
    const choice = this.exact() ?? this.matches()[0];
    if (!choice) return;
    event.preventDefault();
    this.pick(choice);
  }
}
