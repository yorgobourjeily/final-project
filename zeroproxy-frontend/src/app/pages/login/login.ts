import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { api } from '../../api';
import { AuthService } from '../../auth.service';
import { User } from '../../models';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  private readonly auth = inject(AuthService);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly setupRequired = signal<boolean | null>(null);

  protected readonly form = this.fb.group({
    id: ['', Validators.required],
    password: ['', Validators.required],
  });

  protected readonly setupForm = this.fb.group({
    name: ['', Validators.required],
    password: ['', [Validators.required, Validators.minLength(8)]],
    confirmPassword: ['', Validators.required],
  });

  constructor() {
    void this.checkSetup();
  }

  private async checkSetup() {
    try {
      const { setupRequired } = await api<{ setupRequired: boolean }>('GET', '/setup/status');
      this.setupRequired.set(setupRequired);
    } catch (err) {
      this.setupRequired.set(false);
      this.error.set(err instanceof Error ? err.message : 'Could not check the initial setup status.');
    }
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

  protected async setupAdmin() {
    this.error.set('');
    if (this.setupForm.invalid) {
      this.error.set('Enter your name and choose a password with at least 8 characters.');
      return;
    }
    const { name, password, confirmPassword } = this.setupForm.getRawValue();
    if (password !== confirmPassword) {
      this.error.set('The passwords do not match.');
      return;
    }

    this.busy.set(true);
    try {
      const { user } = await api<{ user: User }>('POST', '/setup/admin', { name, password });
      this.setupRequired.set(false);
      this.form.setValue({ id: user.loginId, password });
      const loginError = await this.auth.login(user.loginId, password);
      if (loginError) this.error.set(`Administrator created with ID ${user.loginId}. ${loginError}`);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Could not create the administrator account.');
    } finally {
      this.busy.set(false);
    }
  }
}
