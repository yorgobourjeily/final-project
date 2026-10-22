import { Routes } from '@angular/router';
import { guestGuard, roleGuard } from './guards';

export const routes: Routes = [
  {
    path: 'login',
    title: 'Sign in · ZeroProxy',
    canActivate: [guestGuard],
    loadComponent: () => import('./pages/login/login').then((m) => m.Login),
  },
  {
    path: 'student',
    title: 'Student · ZeroProxy',
    canActivate: [roleGuard('student')],
    loadComponent: () => import('./pages/student/student').then((m) => m.Student),
  },
  {
    path: 'parent',
    title: 'Parent · ZeroProxy',
    canActivate: [roleGuard('parent')],
    loadComponent: () => import('./pages/parent/parent').then((m) => m.Parent),
  },
  {
    path: 'teacher',
    title: 'Teacher · ZeroProxy',
    canActivate: [roleGuard('teacher')],
    loadComponent: () => import('./pages/teacher/teacher').then((m) => m.Teacher),
  },
  {
    path: 'admin',
    title: 'Admin · ZeroProxy',
    canActivate: [roleGuard('admin')],
    loadComponent: () => import('./pages/admin/admin').then((m) => m.Admin),
  },
  { path: '**', redirectTo: 'login' },
];
