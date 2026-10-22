import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../auth.service';

/** Everyone signs in with their ID: admins a…, teachers t…, parents p…, students digits. */
const DEMO_ACCOUNTS = [
  { role: 'Admin', id: 'a1', password: 'admin123' },
  { role: 'Teacher', id: 't1', password: 'teacher123' },
  { role: 'Parent', id: 'p3', password: 'parent123' },
  { role: 'Student', id: '1', password: 'student123' },
];

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  private readonly auth = inject(AuthService);
  protected readonly demoAccounts = DEMO_ACCOUNTS;
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  protected readonly form = inject(NonNullableFormBuilder).group({
    id: ['', Validators.required],
    password: ['', Validators.required],
  });

  protected fill(id: string, password: string) {
    this.form.setValue({ id, password });
    this.error.set('');
  }

  protected async submit() {
    if (this.form.invalid) {
      this.error.set('Enter your ID and password.');
      return;
    }
    const { id, password } = this.form.getRawValue();
    this.busy.set(true);
    this.error.set((await this.auth.login(id, password)) ?? '');
    this.busy.set(false);
  }
}
