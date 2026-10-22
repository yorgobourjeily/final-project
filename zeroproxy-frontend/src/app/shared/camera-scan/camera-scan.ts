import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { DataService } from '../../data.service';

type ScanState = 'idle' | 'starting' | 'live' | 'scanning' | 'error';

/**
 * Opens the webcam and "recognises" the face in front of it.
 * Real recognition needs a trained model / server, so here the scan is simulated:
 * a frame is captured, analysed for ~1.5s, then `recognised` fires.
 * No image is stored — only the attendance result is saved.
 */
@Component({
  selector: 'app-camera-scan',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './camera-scan.html',
  styleUrl: './camera-scan.css',
})
export class CameraScan {
  private readonly data = inject(DataService);
  private readonly video = viewChild.required<ElementRef<HTMLVideoElement>>('video');
  private stream: MediaStream | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  readonly recognised = output();
  protected readonly state = signal<ScanState>('idle');
  protected readonly error = signal('');

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.timer);
      this.stop();
    });
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail('This browser does not support camera access.');
      return;
    }
    this.state.set('starting');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
      this.video().nativeElement.srcObject = this.stream;
      this.state.set('live');
    } catch {
      this.fail('Camera permission was denied or no camera was found.');
    }
  }

  scan() {
    this.state.set('scanning');
    this.timer = setTimeout(() => {
      this.stop();
      this.recognised.emit();
    }, 1500);
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.state() !== 'error') this.state.set('idle');
  }

  private fail(message: string) {
    this.error.set(message);
    this.state.set('error');
    this.data.log('warning', `Camera unavailable: ${message}`);
  }
}
