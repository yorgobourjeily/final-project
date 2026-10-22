import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../auth.service';

const DEMO_ACCOUNTS = [
  { role: 'Admin', username: 'admin', password: 'admin123' },
  { role: 'Teacher', username: 'teacher', password: 'teacher123' },
  { role: 'Parent', username: 'parent3', password: 'parent123' },
  { role: 'Student', username: 'student1', password: 'student123' },
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

  protected readonly form = inject(NonNullableFormBuilder).group({
    username: ['', Validators.required],
    password: ['', Validators.required],
  });

  protected fill(username: string, password: string) {
    this.form.setValue({ username, password });
    this.error.set('');
  }

  protected submit() {
    if (this.form.invalid) {
      this.error.set('Enter your username and password.');
      return;
    }
    const { username, password } = this.form.getRawValue();
    if (!this.auth.login(username, password)) this.error.set('Wrong username or password.');
  }
}
