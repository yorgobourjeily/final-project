import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';
import { Role } from './models';

/** Only lets in a logged-in user with the given role; others go to their own portal. */
export const roleGuard =
  (role: Role): CanActivateFn =>
  () => {
    const user = inject(AuthService).user();
    const router = inject(Router);
    if (!user) return router.parseUrl('/login');
    return user.role === role ? true : router.parseUrl(`/${user.role}`);
  };

/** Sends already-logged-in users from the login page to their portal. */
export const guestGuard: CanActivateFn = () => {
  const user = inject(AuthService).user();
  return user ? inject(Router).parseUrl(`/${user.role}`) : true;
};
