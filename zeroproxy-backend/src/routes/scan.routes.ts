import { timingSafeEqual } from 'node:crypto';
import { RequestHandler, Router } from 'express';
import { requireAuth } from '../auth';
import { config } from '../config';
import { one, pool, rows, transaction } from '../db';
import { FACE_EMBEDDING_SIZE, FACE_MATCH_THRESHOLD, normalizedEmbedding } from '../faces';
import { addLog, alertFamily, classForArrival, dayOff, dayOffText, isLoginIdFor, lateCutoff, saveRecord, statusForTime } from '../logic';
import { AttendanceRow, ClassRow, UserRow } from '../types';
import { clock, dateKey, HttpError, toMinutes } from '../utils';

export const scanRoutes = Router();

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Lets in the camera machine (X-Device-Key header) or a signed-in admin (to test scans from the website). */
const cameraOrAdmin: RequestHandler = async (req, res, next) => {
  const key = req.header('x-device-key');
  if (key !== undefined) {
    if (!config.deviceKey) throw new HttpError(503, 'Scanning is disabled: set DEVICE_KEY in zeroproxy-backend/.env.');
    if (!sameSecret(key, config.deviceKey)) throw new HttpError(401, 'Invalid device key.');
    next();
    return;
  }

  if (!req.header('authorization')) throw new HttpError(401, 'Missing the X-Device-Key header.');
  let signedIn = false;
  await requireAuth(req, res, () => {
    signedIn = true;
  });
  if (!signedIn || req.auth?.role !== 'admin') {
    throw new HttpError(403, 'Only the camera machine (with its device key) or an admin can send scans.');
  }
  next();
};

interface FaceCandidate extends UserRow {
  embedding: number[];
}

async function matchFace(value: unknown): Promise<{ student: UserRow; similarity: number }> {
  const embedding = normalizedEmbedding(value);
  const candidates = await rows<FaceCandidate>(
    pool,
    `SELECT u.*, f.embedding
     FROM face_embeddings f
     JOIN users u ON u.id = f.student_id
     WHERE u.role = 'student'`,
  );
  if (candidates.length === 0) throw new HttpError(404, 'No student face templates have been enrolled.');

  let best: FaceCandidate | undefined;
  let bestSimilarity = -1;
  for (const candidate of candidates) {
    if (!Array.isArray(candidate.embedding) || candidate.embedding.length !== FACE_EMBEDDING_SIZE) continue;
    const storedMagnitude = Math.hypot(...candidate.embedding);
    if (storedMagnitude < 1e-12) continue;
    const dot = embedding.reduce((sum, value, index) => sum + value * candidate.embedding[index], 0);
    const similarity = dot / storedMagnitude;
    if (similarity > bestSimilarity) {
      best = candidate;
      bestSimilarity = similarity;
    }
  }
  if (!best || bestSimilarity < FACE_MATCH_THRESHOLD) throw new HttpError(404, 'No enrolled student face matched.');

  const { embedding: _embedding, ...student } = best;
  return { student, similarity: bestSimilarity };
}

/** Enrolls or replaces a student's averaged face embedding. */
scanRoutes.post('/face-enrollments', cameraOrAdmin, async (req, res) => {
  const body = req.body ?? {};
  const rawId: unknown = body.id ?? body.studentId;
  const studentId = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
  if (!isLoginIdFor('student', studentId)) {
    throw new HttpError(400, 'Send the numeric student login ID in "id".');
  }

  const student = await one<UserRow>(pool, "SELECT * FROM users WHERE role = 'student' AND login_id = $1", [studentId]);
  if (!student) throw new HttpError(404, `No student has the id "${studentId}".`);
  const embedding = normalizedEmbedding(body.embedding);
  await pool.query(
    `INSERT INTO face_embeddings (student_id, embedding, model)
     VALUES ($1, $2::jsonb, 'buffalo_l')
     ON CONFLICT (student_id) DO UPDATE
     SET embedding = EXCLUDED.embedding, model = EXCLUDED.model, updated_at = now()`,
    [student.id, JSON.stringify(embedding)],
  );
  await addLog(pool, 'info', `Face template enrolled for ${student.name} (${student.login_id})`);
  res.status(201).json({ student: { name: student.name, id: student.login_id }, message: `Face template saved for ${student.name}.` });
});

/**
 * The arrival time sent by the camera: "08:05", "08:05:30" (today) or a full ISO date-time.
 * Returns null when it cannot be read.
 */
function parseArrival(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  const hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (hm) {
    const [h, m, s] = [Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0)];
    if (h > 23 || m > 59 || s > 59) return null;
    const today = new Date();
    today.setHours(h, m, s, 0);
    return today;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The answer sent back to the camera machine. */
function reply(student: UserRow, schoolClass: ClassRow, record: Pick<AttendanceRow, 'date' | 'time' | 'status'>) {
  const cutoff = lateCutoff(schoolClass);
  const minutesLate = record.time && record.status === 'late' ? toMinutes(record.time) - toMinutes(cutoff) : 0;
  return {
    student: { name: student.name, id: student.login_id, class: schoolClass.name },
    date: record.date,
    time: record.time,
    lateAfter: cutoff,
    minutesLate,
    status: record.status,
  };
}

/** GET /api/scan-status -> whether any class is running, which is when the camera machine scans faces. */
scanRoutes.get('/scan-status', cameraOrAdmin, async (_req, res) => {
  const running = await rows<{ name: string }>(
    pool,
    `SELECT c.name FROM class_sessions s JOIN classes c ON c.id = s.class_id
     WHERE s.date = $1 AND s.ended_at IS NULL ORDER BY c.name`,
    [dateKey()],
  );
  res.json({ scanning: running.length > 0, classes: running.map((c) => c.name) });
});

/**
 * POST /api/scans   { "id": "2", "time": "08:05" } or { "embedding": [...], "time": "08:05" }
 * The camera may send an enrolled student ID or a live face embedding for database matching.
 * The scan counts for the student's earliest running class (started by a teacher) not marked yet.
 * The arrival time is compared with that class's cutoff (start time, or the real start if later,
 * plus the late minutes): present or late is saved, and parents are messaged when late.
 */
scanRoutes.post('/scans', cameraOrAdmin, async (req, res) => {
  const body = req.body ?? {};
  const match = body.embedding === undefined ? undefined : await matchFace(body.embedding);
  const rawId: unknown = match?.student.login_id ?? body.id ?? body.studentId;
  const studentId = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
  if (!isLoginIdFor('student', studentId)) {
    throw new HttpError(400, 'Send the student id as numbers only, for example { "id": "2", "time": "08:05" }.');
  }

  const arrival = parseArrival(body.time);
  if (!arrival) throw new HttpError(400, 'Send the time of arrival, for example "time": "08:05" (or a full date-time).');
  if (dateKey(arrival) !== dateKey()) throw new HttpError(400, 'The time of arrival must be today.');
  if (arrival.getTime() > Date.now() + 60_000) throw new HttpError(400, 'The time of arrival cannot be in the future.');

  const student = match?.student ?? (await one<UserRow>(pool, "SELECT * FROM users WHERE role = 'student' AND login_id = $1", [studentId]));
  if (!student) {
    await addLog(pool, 'warning', `Camera scan for unknown student id "${studentId}"`);
    throw new HttpError(404, `No student has the id "${studentId}".`);
  }

  const date = dateKey(arrival);
  const time = clock(arrival);

  const off = await dayOff(pool, date);
  if (off) throw new HttpError(400, `No school on ${date} (${dayOffText(off)}). Attendance is not taken.`);

  // Which of the student's classes this arrival is for.
  const { classes, target, alreadyMarked } = await classForArrival(pool, student.id, date);
  if (classes.length === 0) throw new HttpError(400, `${student.name} is not in a class yet.`);
  if (!target && alreadyMarked) {
    const schoolClass = classes.find((c) => c.id === alreadyMarked.class_id)!;
    res.json({
      ...reply(student, schoolClass, alreadyMarked),
      alreadyMarked: true,
      message: `${student.name} was already marked ${alreadyMarked.status} in ${schoolClass.name} today.`,
    });
    return;
  }
  if (!target) throw new HttpError(400, `${student.name} has no class running at ${time}: a teacher must start it first.`);
  const schoolClass = target;

  // Compare the arrival time with the class cutoff. A scan also replaces an automatic absence.
  const status = statusForTime(schoolClass, time);
  await transaction(async (db) => {
    await saveRecord(db, { studentId: student.id, classId: schoolClass.id, date, status, time, method: 'face' });
    await addLog(db, 'info', `Camera recognised ${student.name} (${student.login_id}): arrived ${time} for ${schoolClass.name}, ${status}`);
    if (status === 'late') await alertFamily(db, student.id, schoolClass.id, 'late', date, time);
  });

  const result = reply(student, schoolClass, { date, time, status });
  res.status(201).json({
    ...result,
    alreadyMarked: false,
    message:
      status === 'late'
        ? `${student.name} arrived at ${time} for ${schoolClass.name}, ${result.minutesLate} min after ${result.lateAfter}: late.`
        : `${student.name} arrived at ${time} for ${schoolClass.name}, on time (late after ${result.lateAfter}): present.`,
  });
});
