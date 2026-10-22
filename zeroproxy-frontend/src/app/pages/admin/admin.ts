import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../auth.service';
import { DataService } from '../../data.service';
import { Role, ROLE_LABELS } from '../../models';

type Tab = 'users' | 'create' | 'system';

@Component({
  selector: 'app-admin',
  imports: [DatePipe, ReactiveFormsModule],
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
  protected readonly formError = signal('');
  protected readonly formSuccess = signal('');
  protected readonly settingsSaved = signal(false);
  protected readonly confirmReset = signal(false);

  private readonly cameraSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  protected readonly visibleUsers = computed(() => {
    const filter = this.filter();
    return this.data.users().filter((u) => filter === 'all' || u.role === filter);
  });

  protected readonly errorCount = computed(() => this.data.logs().filter((l) => l.level === 'error').length);

  protected readonly checks = computed(() => [
    { label: 'User accounts', value: this.data.users().length, ok: true },
    { label: 'Attendance records', value: this.data.records().length, ok: true },
    { label: 'Data storage', value: this.data.storageOk() ? 'OK' : 'Failing', ok: this.data.storageOk() },
    { label: 'Camera support', value: this.cameraSupported ? 'OK' : 'Missing', ok: this.cameraSupported },
    { label: 'Errors logged', value: this.errorCount(), ok: this.errorCount() === 0 },
  ]);

  protected readonly form = this.fb.group({
    name: ['', Validators.required],
    role: this.fb.control<Role>('student'),
    username: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9._-]+$/)]],
    password: ['', [Validators.required, Validators.minLength(6)]],
    email: ['', Validators.email],
    phone: [''],
    childId: [''],
  });

  protected readonly settingsForm = this.fb.group({
    startTime: [this.data.settings().startTime, Validators.required],
    lateAfterMinutes: [this.data.settings().lateAfterMinutes, [Validators.required, Validators.min(0)]],
    maxAbsences: [this.data.settings().maxAbsences, [Validators.required, Validators.min(1)]],
  });

  protected onFilter(event: Event) {
    this.filter.set((event.target as HTMLSelectElement).value as Role | 'all');
  }

  protected confirmDelete(id: string) {
    this.data.deleteUser(id);
    this.pendingDelete.set(null);
  }

  protected create() {
    this.formSuccess.set('');
    if (this.form.invalid) {
      this.formError.set('Please fill in name, a valid username, and a password of at least 6 characters.');
      return;
    }
    const v = this.form.getRawValue();
    if (v.role === 'parent' && !v.childId) {
      this.formError.set('Choose the child this parent account belongs to.');
      return;
    }

    const error = this.data.createUser({
      name: v.name.trim(),
      username: v.username,
      password: v.password,
      role: v.role,
      email: v.email || undefined,
      phone: v.phone || undefined,
      childId: v.role === 'parent' ? v.childId : undefined,
    });
    if (error) {
      this.formError.set(error);
      return;
    }
    this.formError.set('');
    this.formSuccess.set(`Account for ${v.name} created.`);
    this.form.reset();
  }

  protected saveSettings() {
    this.data.updateSettings(this.settingsForm.getRawValue());
    this.settingsSaved.set(true);
  }

  protected reset() {
    this.data.resetDemoData();
    this.confirmReset.set(false);
    this.settingsForm.reset(this.data.settings());
  }
}
