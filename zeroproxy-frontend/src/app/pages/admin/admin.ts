import { ChangeDetectionStrategy, Component, ElementRef, HostListener, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthService } from '../../auth.service';
import { DataService } from '../../data.service';
import { NewClass, Role, ROLE_LABELS, SchoolClass, User } from '../../models';
import { dateKey, daysText, WEEK_DAYS } from '../../utils';
import { tabInUrl } from '../../tab-state';
import { StudentSearch } from '../../shared/student-search/student-search';
import { DaysOffCalendar } from './days-off-calendar/days-off-calendar';

/** The photos the camera popup takes, in order. Their face codes are averaged into one template. */
const FACE_POSES = [
  { key: 'front', label: 'Front', hint: 'Look straight at the camera.' },
  { key: 'left', label: 'Left side', hint: 'Turn your head slightly to your left (about 30°), eyes still visible.' },
  { key: 'right', label: 'Right side', hint: 'Turn your head slightly to your right (about 30°), eyes still visible.' },
] as const;

interface FaceShot {
  embedding: number[];
  photo: string;
  /** Head turn reported by the encoder, in degrees (sign = direction). */
  yaw: number | null;
}

/** Front must face the camera; each side must be turned, and the two sides in opposite directions. */
function checkPose(pose: (typeof FACE_POSES)[number]['key'], yaw: number, shots: FaceShot[]): string | null {
  if (pose === 'front') return Math.abs(yaw) <= 20 ? null : 'Look straight at the camera for the front photo.';
  if (Math.abs(yaw) < 12) return 'Turn the head a little more to the side, then capture again.';
  const otherSide = shots.find((_, i) => FACE_POSES[i].key !== 'front' && FACE_POSES[i].key !== pose);
  if (otherSide?.yaw != null && Math.sign(otherSide.yaw) === Math.sign(yaw)) {
    return 'That is the same side as before. Turn the head the other way.';
  }
  return null;
}

/** Average of several unit-length face codes, scaled back to unit length. */
function averageEmbedding(embeddings: number[][]): number[] {
  const sum = embeddings[0].map((_, i) => embeddings.reduce((total, e) => total + e[i], 0));
  const magnitude = Math.hypot(...sum);
  return sum.map((v) => v / magnitude);
}

/** A small JPEG data URL of the captured frame, for the form preview. */
function thumbnail(source: HTMLCanvasElement): string {
  const size = 160;
  const side = Math.min(source.width, source.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')?.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.8);
}

const TABS = ['users', 'create', 'classes', 'calendar', 'parents', 'email', 'system'] as const;

/** Where the live scanner (face_live.py live) shows its cameras, on this computer only. */
const CAMERA_VIEW_URL = 'http://localhost:8766';

@Component({
  selector: 'app-admin',
  imports: [DatePipe, ReactiveFormsModule, StudentSearch, DaysOffCalendar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin.html',
  styleUrl: './admin.css',
})
export class Admin implements OnDestroy {
  protected readonly data = inject(DataService);
  protected readonly me = inject(AuthService).user;
  private readonly fb = inject(NonNullableFormBuilder);
  @ViewChild('faceVideo') private faceVideo?: ElementRef<HTMLVideoElement>;
  private cameraStream: MediaStream | null = null;

  protected readonly roles: Role[] = ['student', 'parent', 'teacher', 'admin'];
  protected readonly roleLabels = ROLE_LABELS;
  protected readonly weekDays = WEEK_DAYS;
  protected readonly daysText = daysText;

  protected readonly tab = tabInUrl(TABS, 'users');
  protected readonly filter = signal<Role | 'all'>('all');
  protected readonly pendingDelete = signal<string | null>(null);
  protected readonly pendingClassDelete = signal<string | null>(null);
  protected readonly formError = signal('');
  protected readonly userError = signal('');
  protected readonly formSuccess = signal('');
  protected readonly faceEmbedding = signal<number[] | null>(null);
  /** Photos taken so far in the camera popup (previews stay in the browser; only face codes are sent). */
  protected readonly faceShots = signal<FaceShot[]>([]);
  protected readonly facePoses = FACE_POSES;
  /** The pose the popup is asking for now. */
  protected readonly currentPose = computed(() => FACE_POSES[Math.min(this.faceShots().length, FACE_POSES.length - 1)]);
  protected readonly cameraActive = signal(false);
  protected readonly faceBusy = signal(false);
  protected readonly faceError = signal('');
  protected readonly classError = signal('');
  protected readonly classMessage = signal('');
  protected readonly parentMessage = signal('');
  protected readonly parentFilter = signal('');
  /** Parents matching the search: by parent name, or by a linked child's student ID or name. */
  protected readonly visibleParents = computed(() => {
    const q = this.parentFilter().trim().toLowerCase();
    if (!q) return this.data.parents();
    return this.data.parents().filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        this.data.childrenOf(p.id).some((s) => s.studentNumber?.includes(q) || s.name.toLowerCase().includes(q)),
    );
  });
  // System tab: live camera view
  /** The live cameras being shown; empty while the view is closed. */
  protected readonly cameraViews = signal<{ name: string; url: string }[]>([]);
  protected readonly cameraViewBusy = signal(false);
  protected readonly cameraViewError = signal('');
  /** Today's attendance recorded by the camera, newest first. */
  protected readonly todayScans = computed(() => {
    const today = dateKey();
    return this.data
      .records()
      .filter((r) => r.date === today && r.method === 'face')
      .sort((a, b) => (b.time ?? '').localeCompare(a.time ?? ''))
      .map((record) => {
        const schoolClass = this.data.schoolClass(record.classId);
        return {
          record,
          student: this.data.user(record.studentId),
          schoolClass,
          lateAfter: schoolClass ? this.data.lateCutoff(schoolClass) : '',
        };
      });
  });

  /** Classes tab: search by class name or teacher name. */
  protected readonly classListSearch = signal('');
  protected readonly visibleClasses = computed(() => {
    const q = this.classListSearch().trim().toLowerCase();
    const classes = this.data.classes();
    if (!q) return classes;
    return classes.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.teacherIds.some((id) => this.data.user(id)?.name.toLowerCase().includes(q)),
    );
  });

  /** User accounts: the account whose read-only details are open. */
  protected readonly viewingUserId = signal<string | null>(null);

  protected toggleView(userId: string) {
    this.viewingUserId.update((id) => (id === userId ? null : userId));
  }

  protected selectTab(tab: (typeof TABS)[number]) {
    if (tab !== 'create') this.stopCamera();
    if (tab !== 'system') this.closeCameraView();
    this.tab.set(tab);
  }

  /** Asks the live scanner which cameras it has, and shows them. */
  protected async openCameraView() {
    this.cameraViewBusy.set(true);
    this.cameraViewError.set('');
    try {
      const response = await fetch(`${CAMERA_VIEW_URL}/cameras`);
      if (!response.ok) throw new Error();
      const { cameras } = (await response.json()) as { cameras: { name: string }[] };
      this.cameraViews.set(cameras.map((camera, index) => ({ name: camera.name, url: `${CAMERA_VIEW_URL}/stream/${index}` })));
    } catch {
      this.cameraViewError.set('The live scanner is not running on this computer. Start it with "python face_live.py live", then try again.');
    } finally {
      this.cameraViewBusy.set(false);
    }
  }

  protected closeCameraView() {
    this.cameraViews.set([]);
  }

  protected onCameraViewLost() {
    this.closeCameraView();
    this.cameraViewError.set('The camera view stopped. Check that the live scanner is still running, then try again.');
  }

  protected readonly userSearch = signal('');
  /** Accounts matching the role filter and the search (name or ID). */
  protected readonly visibleUsers = computed(() => {
    const filter = this.filter();
    const q = this.userSearch().trim().toLowerCase();
    return this.data
      .users()
      .filter((u) => filter === 'all' || u.role === filter)
      .filter((u) => !q || u.name.toLowerCase().includes(q) || u.loginId.toLowerCase().includes(q));
  });

  protected readonly errorCount = computed(() => this.data.logs().filter((l) => l.level === 'error').length);

  protected readonly checks = computed(() => [
    { label: 'User accounts', value: this.data.users().length, ok: true },
    { label: 'Classes', value: this.data.classes().length, ok: true },
    { label: 'Attendance records', value: this.data.records().length, ok: true },
    { label: 'Server & database', value: this.data.online() ? 'OK' : 'Offline', ok: this.data.online() },
    { label: 'Camera scans today', value: this.todayScans().length, ok: true },
    { label: 'Errors logged', value: this.errorCount(), ok: this.errorCount() === 0 },
  ]);

  protected readonly form = this.fb.group({
    name: ['', Validators.required],
    role: this.fb.control<Role>('student'),
    password: ['', [Validators.required, Validators.minLength(6)]],
    email: ['', Validators.email],
    phone: [''],
    classId: [''],
  });

  protected readonly classForm = this.fb.group({
    name: ['', Validators.required],
    startTime: ['08:00', Validators.required],
    endTime: ['14:00', Validators.required],
    lateAfterMinutes: [10, [Validators.required, Validators.min(0)]],
    maxAbsences: [5, [Validators.required, Validators.min(1)]],
  });

  // ------------------------------------------------------------ helpers for the template

  protected className(classId: string | undefined): string {
    return this.data.schoolClass(classId)?.name ?? '';
  }

  protected teachersOf(c: SchoolClass): User[] {
    return c.teacherIds.map((id) => this.data.user(id)).filter((u): u is User => !!u);
  }

  /** "Ms. Rana Haddad, Mr. Tony Rizk" for a class. */
  protected teacherNames(c: SchoolClass): string {
    return this.teachersOf(c)
      .map((t) => t.name)
      .join(', ');
  }

  protected teachersNotIn(c: SchoolClass): User[] {
    return this.data.teachers().filter((t) => !c.teacherIds.includes(t.id));
  }

  protected studentsNotIn(c: SchoolClass): User[] {
    return this.data.students().filter((s) => !s.classIds?.includes(c.id));
  }

  // ------------------------------------------------------------ users

  protected onFilter(event: Event) {
    this.filter.set((event.target as HTMLSelectElement).value as Role | 'all');
  }

  /** Opens the Create account tab with the role already chosen. */
  protected startCreate(role: Role) {
    this.resetFaceCapture();
    this.form.reset();
    this.form.controls.role.setValue(role);
    this.childSearch.set('');
    this.formError.set('');
    this.formSuccess.set('');
    this.tab.set('create');
  }

  protected async confirmDelete(id: string) {
    const error = await this.data.deleteUser(id);
    this.pendingDelete.set(null);
    this.userError.set(error ?? '');
  }

  protected async create() {
    this.formSuccess.set('');
    if (this.form.invalid) {
      this.formError.set('Please fill in the name and a password of at least 6 characters.');
      return;
    }
    const v = this.form.getRawValue();
    if (v.role === 'student' && !this.faceEmbedding()) {
      this.formError.set('Capture the student face before creating the account.');
      return;
    }
    // The child is the student whose ID is typed in (or picked) in the search box.
    const child = this.data.students().find((s) => s.loginId === this.childSearch().trim().toLowerCase());
    if (v.role === 'parent' && !child) {
      this.formError.set("Type or pick the child's student ID.");
      return;
    }

    const { error, user } = await this.data.createUser({
      name: v.name.trim(),
      password: v.password,
      role: v.role,
      email: v.email || undefined,
      phone: v.phone || undefined,
      childIds: v.role === 'parent' && child ? [child.id] : undefined,
      classIds: v.role === 'student' && v.classId ? [v.classId] : undefined,
      faceEmbedding: v.role === 'student' ? (this.faceEmbedding() ?? undefined) : undefined,
    });
    if (error) {
      this.formError.set(error);
      return;
    }
    this.formError.set('');
    this.formSuccess.set(`Account for ${v.name} created. They sign in with ID ${user?.loginId} and the password you chose.`);
    this.resetFaceCapture();
    this.form.reset();
    this.childSearch.set('');
  }

  protected async openCamera() {
    this.faceError.set('');
    if (!navigator.mediaDevices?.getUserMedia) {
      this.faceError.set('Camera access is unavailable in this browser or page context.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      this.cameraStream = stream;
      this.cameraActive.set(true);
      const video = this.faceVideo?.nativeElement;
      if (!video) throw new Error('Camera preview is not ready.');
      video.srcObject = stream;
      await video.play();
    } catch (error) {
      this.stopCamera();
      this.faceError.set(error instanceof Error ? error.message : 'Could not open the camera.');
    }
  }

  protected async captureFace() {
    const video = this.faceVideo?.nativeElement;
    if (!video?.videoWidth || !video.videoHeight) {
      this.faceError.set('Wait for the camera preview, then try again.');
      return;
    }
    this.faceBusy.set(true);
    this.faceError.set('');
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
      if (!image) throw new Error('Could not capture an image from the camera.');
      const response = await fetch('http://localhost:8765/encode', {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: image,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error ?? 'Could not encode the captured face.');
      if (!Array.isArray(result.embedding) || result.embedding.length !== 512) {
        throw new Error('The local encoder returned an invalid face template.');
      }
      const yaw = typeof result.yaw === 'number' ? result.yaw : null;
      const poseError = yaw === null ? null : checkPose(this.currentPose().key, yaw, this.faceShots());
      if (poseError) throw new Error(poseError);
      const shots = [...this.faceShots(), { embedding: result.embedding as number[], photo: thumbnail(canvas), yaw }];
      this.faceShots.set(shots);
      if (shots.length === FACE_POSES.length) {
        this.faceEmbedding.set(averageEmbedding(shots.map((s) => s.embedding)));
        this.stopCamera();
      }
    } catch (error) {
      this.faceError.set(
        error instanceof TypeError
          ? 'Face encoder is unavailable. Start the local face encoder service and retry.'
          : error instanceof Error
            ? error.message
            : 'Could not encode the captured face.',
      );
    } finally {
      this.faceBusy.set(false);
    }
  }

  protected onRoleChange() {
    this.resetFaceCapture();
  }

  protected onNameInput() {
    if (this.faceEmbedding()) {
      this.faceEmbedding.set(null);
      this.faceShots.set([]);
      this.faceError.set('Name changed. Capture the face again before creating this account.');
    }
  }

  protected stopCamera() {
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = null;
    this.cameraActive.set(false);
    if (this.faceVideo?.nativeElement) this.faceVideo.nativeElement.srcObject = null;
  }

  protected async retakeFace() {
    this.faceEmbedding.set(null);
    this.faceShots.set([]);
    this.faceError.set('');
    await this.openCamera();
  }

  /** Drops the last photo so that pose can be taken again. */
  protected redoLastShot() {
    this.faceShots.update((shots) => shots.slice(0, -1));
    this.faceError.set('');
  }

  /** Escape closes the camera popup (unless a photo is being encoded). */
  @HostListener('document:keydown.escape')
  protected onEscape() {
    if (this.cameraActive() && !this.faceBusy()) this.stopCamera();
  }

  private resetFaceCapture() {
    this.stopCamera();
    this.faceEmbedding.set(null);
    this.faceShots.set([]);
    this.faceError.set('');
    this.faceBusy.set(false);
  }

  ngOnDestroy() {
    this.stopCamera();
  }

  /** Create account: the child's student ID typed into the search box (parents only). */
  protected readonly childSearch = signal('');

  // ------------------------------------------------------------ classes

  protected async createClass() {
    this.classMessage.set('');
    if (this.classForm.invalid) {
      this.classError.set('Give the class a name, a start and end time, the minutes before students count as late, and a maximum of at least 1 absence.');
      return;
    }
    if (this.newClassDays().length === 0) {
      this.classError.set('Choose at least one day of the week.');
      return;
    }
    const v = this.classForm.getRawValue();
    const error = await this.data.createClass({
      ...v,
      name: v.name.trim(),
      lateAfterMinutes: Math.round(v.lateAfterMinutes),
      maxAbsences: Math.round(v.maxAbsences),
      days: this.newClassDays(),
    });
    if (error) {
      this.classError.set(error);
      return;
    }
    this.classError.set('');
    this.classMessage.set(`Class ${v.name.trim()} created. Now add its teachers and students below.`);
    this.classForm.reset();
    this.newClassDays.set([1, 2, 3, 4, 5]);
  }

  // ------------------------------------------------------------ editing a class
  // A class card is read-only until Edit is clicked. Details are kept in a draft and saved together on Save.

  protected readonly editingClassId = signal<string | null>(null);
  protected readonly classDraft = signal<NewClass | null>(null);
  protected readonly savingClass = signal(false);
  /** The class open in the edit window. */
  protected readonly editingClass = computed(() => this.data.schoolClass(this.editingClassId() ?? ''));

  protected startEdit(c: SchoolClass) {
    this.classDraft.set({
      name: c.name,
      startTime: c.startTime,
      endTime: c.endTime,
      lateAfterMinutes: c.lateAfterMinutes,
      maxAbsences: c.maxAbsences,
      days: [...c.days],
    });
    this.editingClassId.set(c.id);
    this.pendingClassDelete.set(null);
    this.classError.set('');
    this.classMessage.set('');
  }

  protected cancelEdit() {
    this.editingClassId.set(null);
    this.classDraft.set(null);
    this.pendingClassDelete.set(null);
    this.classError.set('');
  }

  protected editDraft<K extends keyof NewClass>(field: K, value: NewClass[K]) {
    this.classDraft.update((d) => (d ? { ...d, [field]: value } : d));
  }

  protected toggleDraftDay(day: number) {
    this.classDraft.update((d) =>
      d ? { ...d, days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day] } : d,
    );
  }

  /** Saves the class details; stays in edit mode if the server refuses them. */
  protected async saveClass(c: SchoolClass) {
    const d = this.classDraft();
    if (!d) return;
    if (!d.name.trim()) return this.classError.set('Give the class a name.');
    if (d.days.length === 0) return this.classError.set(`${c.name} needs at least one day.`);
    this.savingClass.set(true);
    const error = await this.data.updateClass(c.id, {
      ...d,
      name: d.name.trim(),
      lateAfterMinutes: Math.round(d.lateAfterMinutes),
      maxAbsences: Math.round(d.maxAbsences),
    });
    this.savingClass.set(false);
    if (error) {
      this.classMessage.set('');
      this.classError.set(error);
      return;
    }
    this.cancelEdit();
    this.classMessage.set(`${d.name.trim()} saved.`);
  }

  protected inputNumber(event: Event): number {
    return Number((event.target as HTMLInputElement).value);
  }

  protected lateCutoff(c: SchoolClass): string {
    return this.data.lateCutoff(c);
  }

  /** Shows the outcome of a class change: the success text, or the server's error. */
  private async showClassResult(action: Promise<string | null>, success: string) {
    const error = await action;
    this.classError.set(error ?? '');
    this.classMessage.set(error ? '' : success);
  }

  protected addTeacher(c: SchoolClass, teacher: User) {
    return this.showClassResult(
      this.data.setTeacherInClass(c.id, teacher.id, true),
      `${teacher.name} (${teacher.loginId}) now teaches ${c.name}.`,
    );
  }


  /** Days chosen for a new class (Monday–Friday by default). */
  protected readonly newClassDays = signal<number[]>([1, 2, 3, 4, 5]);

  protected toggleNewClassDay(day: number) {
    this.newClassDays.update((days) => (days.includes(day) ? days.filter((d) => d !== day) : [...days, day]));
  }

  protected removeTeacher(c: SchoolClass, teacher: User) {
    return this.showClassResult(this.data.setTeacherInClass(c.id, teacher.id, false), `${teacher.name} no longer teaches ${c.name}.`);
  }

  protected addStudent(c: SchoolClass, student: User) {
    return this.showClassResult(
      this.data.setStudentInClass(c.id, student.id, true),
      `${student.name} (${student.studentNumber}) is now in ${c.name}.`,
    );
  }

  protected removeStudent(c: SchoolClass, student: User) {
    return this.showClassResult(this.data.setStudentInClass(c.id, student.id, false), `${student.name} removed from ${c.name}.`);
  }

  protected async deleteClass(c: SchoolClass) {
    this.pendingClassDelete.set(null);
    await this.showClassResult(this.data.deleteClass(c.id), `Class ${c.name} deleted. Its students stay in their other classes.`);
    if (!this.classError()) {
      this.editingClassId.set(null);
      this.classDraft.set(null);
    }
  }

  // ------------------------------------------------------------ parents

  protected studentsNotLinkedTo(parent: User): User[] {
    return this.data.students().filter((s) => !parent.childIds?.includes(s.id));
  }

  protected async linkChild(parent: User, student: User) {
    const error = await this.data.setParentChild(parent.id, student.id, true);
    this.parentMessage.set(error ?? `${parent.name} is now linked to ${student.name} (${student.studentNumber}).`);
  }

  protected async unlinkChild(parent: User, student: User) {
    const error = await this.data.setParentChild(parent.id, student.id, false);
    this.parentMessage.set(error ?? `${parent.name} is no longer linked to ${student.name}.`);
  }

  // ------------------------------------------------------------ send email

  protected readonly emailSubject = signal('');
  protected readonly emailMessage = signal('');
  protected readonly emailSearch = signal('');
  protected readonly emailRole = signal<Role | 'all'>('all');
  /** Class search: part of a class name. Shows those classes' students, teachers and parents. Empty = every class. */
  protected readonly emailClassSearch = signal('');
  /** Classes whose name matches the class search (null when the search is empty). */
  protected readonly emailClasses = computed(() => {
    const q = this.emailClassSearch().trim().toLowerCase();
    return q ? this.data.classes().filter((c) => c.name.toLowerCase().includes(q)) : null;
  });
  /** IDs of the people ticked to receive the email. */
  protected readonly emailTo = signal<ReadonlySet<string>>(new Set());
  protected readonly emailBusy = signal(false);
  protected readonly emailError = signal('');
  protected readonly emailSuccess = signal('');

  /**
   * People shown in the recipient list: everyone except yourself, filtered by role, class and search.
   * The search matches part of a name or email, or an exact ID (so "1" does not also show 11 or p1).
   */
  protected readonly emailPeople = computed(() => {
    const role = this.emailRole();
    const classes = this.emailClasses();
    const q = this.emailSearch().trim().toLowerCase();
    return this.data
      .users()
      .filter((u) => u.id !== this.me()?.id)
      .filter((u) => role === 'all' || u.role === role)
      .filter((u) => !classes || classes.some((c) => this.isInClass(u, c.id)))
      .filter((u) => !q || u.loginId.toLowerCase() === q || u.name.toLowerCase().includes(q) || !!u.email?.toLowerCase().includes(q));
  });

  /** A student in the class, a teacher of it, or a parent of one of its students. */
  private isInClass(u: User, classId: string): boolean {
    switch (u.role) {
      case 'student':
        return !!u.classIds?.includes(classId);
      case 'teacher':
        return !!this.data.schoolClass(classId)?.teacherIds.includes(u.id);
      case 'parent':
        return this.data.childrenOf(u.id).some((s) => s.classIds?.includes(classId));
      default:
        return false;
    }
  }

  /** People in the list that can be ticked (they have an email address). */
  private readonly emailableShown = computed(() => this.emailPeople().filter((u) => !!u.email));
  protected readonly allShownTicked = computed(
    () => this.emailableShown().length > 0 && this.emailableShown().every((u) => this.emailTo().has(u.id)),
  );

  protected toggleRecipient(id: string) {
    this.emailTo.update((set) => {
      const next = new Set(set);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Ticks every person shown (or unticks them all when they are already ticked). */
  protected toggleAllShown() {
    const shown = this.emailableShown().map((u) => u.id);
    const untick = this.allShownTicked();
    this.emailTo.update((set) => {
      const next = new Set(set);
      shown.forEach((id) => (untick ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  protected onEmailRole(event: Event) {
    this.emailRole.set((event.target as HTMLSelectElement).value as Role | 'all');
  }

  protected async sendEmail() {
    this.emailError.set('');
    this.emailSuccess.set('');
    if (this.emailTo().size === 0) return this.emailError.set('Tick at least one person.');
    if (!this.emailSubject().trim()) return this.emailError.set('Write a subject.');
    if (!this.emailMessage().trim()) return this.emailError.set('Write a message.');
    this.emailBusy.set(true);
    const { error, queued, skipped } = await this.data.sendEmail([...this.emailTo()], this.emailSubject().trim(), this.emailMessage().trim());
    this.emailBusy.set(false);
    if (error) return this.emailError.set(error);
    this.emailSuccess.set(
      `Email on its way to ${queued} person(s).` + (skipped.length ? ` Skipped (no email address): ${skipped.join(', ')}.` : '') +
        ' Check the System log to see each delivery.',
    );
    this.emailSubject.set('');
    this.emailMessage.set('');
    this.emailTo.set(new Set());
  }

  // ------------------------------------------------------------ helpers

  protected inputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
