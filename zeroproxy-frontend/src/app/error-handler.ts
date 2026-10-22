import { ErrorHandler, inject, Injectable } from '@angular/core';
import { DataService } from './data.service';

/** Records unexpected errors in the system log so the admin can see them. */
@Injectable()
export class LoggingErrorHandler implements ErrorHandler {
  private readonly data = inject(DataService);

  handleError(error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    queueMicrotask(() => this.data.log('error', message));
  }
}
