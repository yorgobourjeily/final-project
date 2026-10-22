import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { DataService } from './data.service';

const SESSION_KEY = 'zeroproxy-session';

function readSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly data = inject(DataService);
  private readonly router = inject(Router);
  private readonly userId = signal<string | null>(readSession());

  /** The logged-in user, or undefined. Becomes undefined if the account is deleted. */
  readonly user = computed(() => this.data.user(this.userId() ?? undefined));

  login(username: string, password: string): boolean {
    const user = this.data
      .users()
      .find((u) => u.username === username.trim().toLowerCase() && u.password === password);
    if (!user) return false;

    this.setSession(user.id);
    this.router.navigateByUrl(`/${user.role}`);
    return true;
  }

  logout() {
    this.setSession(null);
    this.router.navigateByUrl('/login');
  }

  private setSession(id: string | null) {
    this.userId.set(id);
    try {
      if (id) sessionStorage.setItem(SESSION_KEY, id);
      else sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // Session just won't survive a refresh.
    }
  }
}
