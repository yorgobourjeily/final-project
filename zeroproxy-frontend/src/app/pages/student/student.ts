import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { AuthService } from '../../auth.service';
import { StudentAttendance } from '../../shared/student-attendance/student-attendance';

@Component({
  selector: 'app-student',
  imports: [DatePipe, StudentAttendance],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './student.html',
})
export class Student {
  protected readonly user = inject(AuthService).user;
  protected readonly today = new Date();
}
