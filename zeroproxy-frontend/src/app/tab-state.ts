import { effect, inject, signal, WritableSignal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';

/**
 * The open tab of a page, kept in the address bar (?tab=classes) so a refresh stays on it.
 * Call it in a field initializer of a routed component.
 */
export function tabInUrl<T extends string>(tabs: readonly T[], fallback: T): WritableSignal<T> {
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  const fromUrl = route.snapshot.queryParamMap.get('tab') as T | null;
  const tab = signal<T>(fromUrl && tabs.includes(fromUrl) ? fromUrl : fallback);

  effect(() => {
    router.navigate([], { relativeTo: route, queryParams: { tab: tab() }, replaceUrl: true });
  });
  return tab;
}
