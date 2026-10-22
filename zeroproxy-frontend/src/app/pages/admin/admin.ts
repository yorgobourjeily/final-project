import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../auth.service';
import { DataService, ScanReply } from '../../data.service';
import { Role, ROLE_LABELS, SchoolClass, User } from '../../models';
import { clock, dateKey } from '../../utils';
import { StudentSearch } from '../../shared/student-search/student-search';

type Tab = 'users' | 'create' | 'classes' | 'parents' | 'scanner' | 'system';

/** Shown in the Camera scanner tab: what the camera machine must send. */
const MACHINE_REQUEST = `POST http://<server>:3000/api/scans
Content-Type: application/json
X-Device-Key: <DEVICE_KEY from zeroproxy-backend/.env>

{ "id": "2", "time": "08:05" }`;

@Component({
  selector: 'app-admin',
  imports: [DatePipe, ReactiveFormsModule, StudentSearch],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin.html',
  styleUrl: './admin.css',
})
export class Admin {
  protected readonly data = inject(DataService);
  protected readonly me = inject(AuthService).user;
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly roles: Role[] = ['student', 'parent', 'teacher', 'admin'];
  protected readonly roleLabels = ROLE_LABELS;

  protected readonly tab = signal<Tab>('users');
  protected readonly filter = signal<Role | 'all'>('all');
  protected readonly pendingDelete = signal<string | null>(null);
  protected readonly pendingClassDelete = signal<string | null>(null);
  protected readonly formError = signal('');
  protected readonly userError = signal('');
  protected readonly formSuccess = signal('');
  protected readonly classError = signal('');
  protected readonly classMessage = signal('');
  protected readonly parentMessage = signal('');
  protected readonly parentFilter = signal('');
  /** Parents matching the search: by parent name, or by a linked child's student ID or name. */
  protected readonly visibleParents = computed(() => {
    const q = this.parentFilter().trim().toLowerCase();
    if (!q) return this.data.parents();
    return this.data.parents().filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        this.data.childrenOf(p.id).some((s) => s.studentNumber?.includes(q) || s.name.toLowerCase().includes(q)),
    );
  });
  protected readonly confirmReset = signal(false);

  // Camera scanner tab
  protected readonly machineRequest = MACHINE_REQUEST;
  protected readonly scanId = signal('');
  protected readonly scanTime = signal(clock());
  protected readonly scanBusy = signal(false);
  protected readonly scanError = signal('');
  protected readonly scanResult = signal<ScanReply | null>(null);
  protected readonly scanPayload = computed(() =>
    JSON.stringify({ id: this.scanId().trim(), time: this.scanTime() }, null, 2),
  );
  /** The student whose ID is typed in exactly. */
  protected readonly scanStudent = computed(() => this.data.students().find((s) => s.studentNumber === this.scanId().trim()));
  /**
   * Frontend's own check before sending (same rules as the server): which class the arrival counts
   * for, and whether the time is before or after that class's cutoff.
   */
  protected readonly scanPreview = computed(() => {
    const student = this.scanStudent();
    if (!student || !this.scanTime()) return null;
    const schoolClass = this.data.classForArrival(student.id, dateKey(), this.scanTime());
    if (!schoolClass) return { className: '', lateAfter: '', status: null };
    return {
      className: schoolClass.name,
      lateAfter: this.data.lateCutoff(schoolClass),
      status: this.data.statusForTime(schoolClass, this.scanTime()),
    };
  });
  protected readonly scanResultJson = computed(() => JSON.stringify(this.scanResult(), null, 2));
  /** Today's attendance recorded by the camera, newest first. */
  protected readonly todayScans = computed(() => {
    const today = dateKey();
    return this.data
      .records()
      .filter((r) => r.date === today && r.method === 'face')
      .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))
      .map((record) => {
        const schoolClass = this.data.schoolClass(record.classId);
        return {
          record,
          student: this.data.user(record.studentId),
          schoolClass,
          lateAfter: schoolClass ? this.data.lateCutoff(schoolClass) : '',
        };
      });
  });

  protected readonly userSearch = signal('');
  /** Accounts matching the role filter and the search (name or ID). */
  protected readonly visibleUsers = computed(() => {
    const filter = this.filter();
    const q = this.userSearch().trim().toLowerCase();
    return this.data
      .users()
      .filter((u) => filter === 'all' || u.role === filter)
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.loginId.toLowerCase().includes(q));
  });

  protected readonly errorCount = computed(() => this.data.logs().filter((l) => l.level === 'error').length);

  protected readonly checks = computed(() => [
    { label: 'User accounts', value: this.data.users().length, ok: true },
    { label: 'Classes', value: this.data.classes().length, ok: true },
    { label: 'Attendance records', value: this.data.records().length, ok: true },
    { label: 'Server & database', value: this.data.online() ? 'OK' : 'Offline', ok: this.data.online() },
    { label: 'Camera scans today', value: this.todayScans().length, ok: true },
    { label: 'Errors logged', value: this.errorCount(), ok: this.errorCount() === 0 },
  ]);

  protected readonly form = this.fb.group({
    name: ['', Validators.required],
    role: this.fb.control<Role>('student'),
    password: ['', [Validators.required, Validators.minLength(6)]],
    email: ['', Validators.email],
    phone: [''],
    childId: [''],
    classId: [''],
  });

  protected readonly classForm = this.fb.group({
    name: ['', Validators.required],
    startTime: ['08:00', Validators.required],
    endTime: ['14:00', Validators.required],
    lateAfterMinutes: [10, [Validators.required, Validators.min(0)]],
    maxAbsences: [5, [Validators.required, Validators.min(1)]],
  });

  // ------------------------------------------------------------ helpers for the template

  protected className(classId: string | undefined): string {
    return this.data.schoolClass(classId)?.name ?? '';
  }

  protected teachersOf(c: SchoolClass): User[] {
    return c.teacherIds.map((id) => this.data.user(id)).filter((u): u is User => !!u);
  }

  protected teachersNotIn(c: SchoolClass): User[] {
    return this.data.teachers().filter((t) => !c.teacherIds.includes(t.id));
  }

  protected studentsNotIn(c: SchoolClass): User[] {
    return this.data.students().filter((s) => !s.classIds?.includes(c.id));
  }

  // ------------------------------------------------------------ users

  protected onFilter(event: Event) {
    this.filter.set((event.target as HTMLSelectElement).value as Role | 'all');
  }

  /** Opens the Create account tab with the role already chosen. */
  protected startCreate(role: Role) {
    this.form.reset();
    this.form.controls.role.setValue(role);
    this.formError.set('');
    this.formSuccess.set('');
    this.tab.set('create');
  }

  protected async confirmDelete(id: string) {
    const error = await this.data.deleteUser(id);
    this.pendingDelete.set(null);
    this.userError.set(error ?? '');
  }

  protected async create() {
    this.formSuccess.set('');
    if (this.form.invalid) {
      this.formError.set('Please fill in the name and a password of at least 6 characters.');
      return;
    }
    const v = this.form.getRawValue();
    if (v.role === 'parent' && !v.childId) {
      this.formError.set('Choose the child this parent account belongs to.');
      return;
    }

    const { error, user } = await this.data.createUser({
      name: v.name.trim(),
      password: v.password,
      role: v.role,
      email: v.email || undefined,
      phone: v.phone || undefined,
      childIds: v.role === 'parent' ? [v.childId] : undefined,
      classIds: v.role === 'student' && v.classId ? [v.classId] : undefined,
    });
    if (error) {
      this.formError.set(error);
      return;
    }
    this.formError.set('');
    this.formSuccess.set(`Account for ${v.name} created. They sign in with ID ${user?.loginId} and the password you chose.`);
    this.form.reset();
  }

  // ------------------------------------------------------------ classes

  protected async createClass() {
    this.classMessage.set('');
    if (this.classForm.invalid) {
      this.classError.set('Give the class a name, a start and end time, the minutes before students count as late, and a maximum of at least 1 absence.');
      return;
    }
    const v = this.classForm.getRawValue();
    const error = await this.data.createClass({
      ...v,
      name: v.name.trim(),
      lateAfterMinutes: Math.round(v.lateAfterMinutes),
      maxAbsences: Math.round(v.maxAbsences),
    });
    if (error) {
      this.classError.set(error);
      return;
    }
    this.classError.set('');
    this.classMessage.set(`Class ${v.name.trim()} created. Now add its teachers and students below.`);
    this.classForm.reset();
  }

  protected onClassName(c: SchoolClass, event: Event) {
    const input = event.target as HTMLInputElement;
    const name = input.value.trim();
    if (!name || name === c.name) return;
    this.applyClassChange(c, { name }, `Class renamed to ${name}.`, () => (input.value = c.name));
  }

  protected onClassStart(c: SchoolClass, event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.value) return;
    this.applyClassChange(c, { startTime: input.value }, `${c.name} now starts at ${input.value}.`, () => (input.value = c.startTime));
  }

  protected onClassEnd(c: SchoolClass, event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.value) return;
    this.applyClassChange(c, { endTime: input.value }, `${c.name} now ends at ${input.value}.`, () => (input.value = c.endTime));
  }

  protected onClassLate(c: SchoolClass, event: Event) {
    const minutes = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(minutes) || minutes < 0) return;
    this.applyClassChange(c, { lateAfterMinutes: Math.round(minutes) }, `${c.name}: students are now late after ${minutes} minute(s).`);
  }

  protected onClassMax(c: SchoolClass, event: Event) {
    const input = event.target as HTMLInputElement;
    const max = Math.round(Number(input.value));
    if (!Number.isFinite(max)) return;
    this.applyClassChange(c, { maxAbsences: max }, `${c.name}: maximum absences set to ${max}.`, () => (input.value = String(c.maxAbsences)));
  }

  private async applyClassChange(c: SchoolClass, changes: Parameters<DataService['updateClass']>[1], success: string, undo?: () => void) {
    await this.showClassResult(this.data.updateClass(c.id, changes), success);
    if (this.classError()) undo?.();
  }

  /** Shows the outcome of a class change: the success text, or the server's error. */
  private async showClassResult(action: Promise<string | null>, success: string) {
    const error = await action;
    this.classError.set(error ?? '');
    this.classMessage.set(error ? '' : success);
  }

  protected async addTeacher(c: SchoolClass, select: HTMLSelectElement) {
    if (!select.value) {
      this.classMessage.set('');
      this.classError.set(`Choose a teacher to add to ${c.name} first.`);
      return;
    }
    const name = this.data.user(select.value)?.name;
    await this.showClassResult(this.data.setTeacherInClass(c.id, select.value, true), `${name} now teaches ${c.name}.`);
    select.value = '';
  }

  protected removeTeacher(c: SchoolClass, teacher: User) {
    return this.showClassResult(this.data.setTeacherInClass(c.id, teacher.id, false), `${teacher.name} no longer teaches ${c.name}.`);
  }

  protected addStudent(c: SchoolClass, student: User) {
    return this.showClassResult(
      this.data.setStudentInClass(c.id, student.id, true),
      `${student.name} (${student.studentNumber}) is now in ${c.name}.`,
    );
  }

  protected removeStudent(c: SchoolClass, student: User) {
    return this.showClassResult(this.data.setStudentInClass(c.id, student.id, false), `${student.name} removed from ${c.name}.`);
  }

  protected async deleteClass(c: SchoolClass) {
    this.pendingClassDelete.set(null);
    await this.showClassResult(this.data.deleteClass(c.id), `Class ${c.name} deleted. Its students stay in their other classes.`);
  }

  // ------------------------------------------------------------ parents

  protected studentsNotLinkedTo(parent: User): User[] {
    return this.data.students().filter((s) => !parent.childIds?.includes(s.id));
  }

  protected async linkChild(parent: User, student: User) {
    const error = await this.data.setParentChild(parent.id, student.id, true);
    this.parentMessage.set(error ?? `${parent.name} is now linked to ${student.name} (${student.studentNumber}).`);
  }

  protected async unlinkChild(parent: User, student: User) {
    const error = await this.data.setParentChild(parent.id, student.id, false);
    this.parentMessage.set(error ?? `${parent.name} is no longer linked to ${student.name}.`);
  }

  // ------------------------------------------------------------ camera scanner

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }


  /** Sends the scan exactly like the camera machine would, and shows the server's reply. */
  protected async sendScan() {
    this.scanBusy.set(true);
    this.scanError.set('');
    this.scanResult.set(null);
    try {
      this.scanResult.set(await this.data.testScan(this.scanId().trim(), this.scanTime()));
    } catch (err) {
      this.scanError.set(err instanceof Error ? err.message : 'The scan failed.');
    }
    this.scanBusy.set(false);
  }

  // ------------------------------------------------------------ system

  protected async reset() {
    this.confirmReset.set(false);
    this.userError.set((await this.data.resetDemoData()) ?? '');
  }
}
