import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { Router, RouterLink, RouterOutlet } from '@angular/router';
import { AuthService } from './auth.service';
import { DataService } from './data.service';
import { ROLE_LABELS } from './models';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly auth = inject(AuthService);
  private readonly data = inject(DataService);
  private readonly router = inject(Router);

  protected readonly user = this.auth.user;
  protected readonly roleLabels = ROLE_LABELS;
  /** Unread count for the header badge. Only teachers and admins have a notifications list. */
  protected readonly unread = computed(() => {
    const u = this.user();
    if (!u || u.role === 'parent' || u.role === 'student') return 0;
    return this.data.notificationsOf(u.id).filter((n) => !n.read).length;
  });

  constructor() {
    // If the logged-in account disappears (deleted, or demo data reset), go back to login.
    effect(() => {
      if (!this.user() && !this.router.url.startsWith('/login')) this.router.navigateByUrl('/login');
    });
  }
}
