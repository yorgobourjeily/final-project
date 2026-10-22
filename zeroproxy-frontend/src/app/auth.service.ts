import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { api, session } from './api';
import { DataService } from './data.service';
import { User } from './models';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly userId = signal<string | null>(session.userId);

  /** The logged-in user, or undefined (also when the session expired or the account was deleted). */
  readonly user = computed(() => this.data.user(this.userId() ?? undefined));

  /** Signs in with the account's ID (e.g. "2", "t1", "p2", "a1"). Returns an error message, or null. */
  async login(id: string, password: string): Promise<string | null> {
    try {
      const { token, user } = await api<{ token: string; user: User }>('POST', '/auth/login', { id, password });
      session.save(token, user.id);
      this.userId.set(user.id);
      await this.data.load();
      this.router.navigateByUrl(`/${user.role}`);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Could not sign in.';
    }
  }

  logout() {
    session.clear();
    this.userId.set(null);
    this.data.clear();
    this.router.navigateByUrl('/login');
  }

  /** On app start: if this tab has a saved session, load the data for it. */
  async restore() {
    if (!session.token) return;
    try {
      await this.data.load();
    } catch {
      session.clear();
      this.userId.set(null);
    }
  }
}
