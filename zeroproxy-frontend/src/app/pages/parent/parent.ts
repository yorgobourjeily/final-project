import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AuthService } from '../../auth.service';
import { DataService } from '../../data.service';
import { dateKey } from '../../utils';
import { StatusBadge } from '../../shared/status-badge/status-badge';
import { StudentAttendance } from '../../shared/student-attendance/student-attendance';

@Component({
  selector: 'app-parent',
  imports: [StatusBadge, StudentAttendance],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './parent.html',
  styleUrl: './parent.css',
})
export class Parent {
  protected readonly data = inject(DataService);
  protected readonly user = inject(AuthService).user;
  private readonly chosenChildId = signal<string | null>(null);

  /** All students linked to this parent, with today's status in each of their classes. */
  protected readonly children = computed(() => {
    const today = dateKey();
    return this.data.childrenOf(this.user()?.id ?? '').map((child) => ({
      child,
      classes: this.data.classesOf(child.id).map((schoolClass) => ({
        schoolClass,
        today: this.data.recordOn(child.id, schoolClass.id, today),
      })),
    }));
  });

  /** The child whose attendance is shown: the one picked, or the first. */
  protected readonly child = computed(() => {
    const all = this.children().map((c) => c.child);
    return all.find((c) => c.id === this.chosenChildId()) ?? all[0];
  });

  protected pick(childId: string) {
    this.chosenChildId.set(childId);
  }
}
