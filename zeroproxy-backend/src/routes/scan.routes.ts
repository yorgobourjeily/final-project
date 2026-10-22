import { timingSafeEqual } from 'node:crypto';
import { RequestHandler, Router } from 'express';
import { requireAuth } from '../auth';
import { config } from '../config';
import { one, pool, transaction } from '../db';
import { addLog, alertFamily, classForArrival, isLoginIdFor, lateCutoff, saveRecord, statusForTime } from '../logic';
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

/**
 * POST /api/scans   { "id": "2", "time": "08:05" }
 * Sent by the camera machine when it recognises a student's face: the student id and time of arrival.
 * The scan counts for the student's earliest class today that has not ended and is not marked yet.
 * The arrival time is compared with that class's cutoff (start time + late minutes):
 * present or late is saved, and parents are messaged when late.
 */
scanRoutes.post('/scans', cameraOrAdmin, async (req, res) => {
  const body = req.body ?? {};
  const rawId: unknown = body.id ?? body.studentId;
  const studentId = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
  if (!isLoginIdFor('student', studentId)) {
    throw new HttpError(400, 'Send the student id as numbers only, for example { "id": "2", "time": "08:05" }.');
  }

  const arrival = parseArrival(body.time);
  if (!arrival) throw new HttpError(400, 'Send the time of arrival, for example "time": "08:05" (or a full date-time).');
  if (dateKey(arrival) !== dateKey()) throw new HttpError(400, 'The time of arrival must be today.');
  if (arrival.getTime() > Date.now() + 60_000) throw new HttpError(400, 'The time of arrival cannot be in the future.');

  const student = await one<UserRow>(pool, "SELECT * FROM users WHERE role = 'student' AND login_id = $1", [studentId]);
  if (!student) {
    await addLog(pool, 'warning', `Camera scan for unknown student id "${studentId}"`);
    throw new HttpError(404, `No student has the id "${studentId}".`);
  }

  const date = dateKey(arrival);
  const time = clock(arrival);

  // Which of the student's classes this arrival is for.
  const { classes, target, alreadyMarked } = await classForArrival(pool, student.id, date, time);
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
  if (!target) throw new HttpError(400, `${student.name} has no class still running at ${time} today.`);
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
