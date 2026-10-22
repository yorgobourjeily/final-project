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
  protected readonly unread = computed(() => {
    const id = this.user()?.id;
    return id ? this.data.notificationsOf(id).filter((n) => !n.read).length : 0;
  });

  constructor() {
    // If the logged-in account disappears (deleted, or demo data reset), go back to login.
    effect(() => {
      if (!this.user() && !this.router.url.startsWith('/login')) this.router.navigateByUrl('/login');
    });
  }
}
