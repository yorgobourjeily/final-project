import { Router } from 'express';
import { requireRole } from '../auth';
import { one, pool, transaction } from '../db';
import { addLog, getClass } from '../logic';
import { HttpError, isDate, param } from '../utils';

// School-wide days off: no class on those dates, so no attendance is taken and nobody is marked absent.
export const daysOffRoutes = Router();

/** PUT /api/days-off/:date  { reason? }  (admin) marks a date as a day off (or changes its reason). */
daysOffRoutes.put('/days-off/:date', requireRole('admin'), async (req, res) => {
  const date = param(req.params.date);
  if (!isDate(date)) throw new HttpError(400, 'Choose a valid date (YYYY-MM-DD).');
  const raw = req.body?.reason;
  const reason = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 100) : null;

  const removed = await transaction(async (db) => {
    await db.query('INSERT INTO days_off (date, reason) VALUES ($1, $2) ON CONFLICT (date) DO UPDATE SET reason = $2', [date, reason]);
    // Automatic absences already given for that date no longer apply.
    const deleted = await db.query("DELETE FROM attendance WHERE date = $1 AND method = 'auto'", [date]);
    await addLog(db, 'info', `Day off on ${date}${reason ? ` (${reason})` : ''}: no attendance taken`);
    return deleted.rowCount ?? 0;
  });
  res.json({ date, reason, removedAbsences: removed });
});

/** PUT /api/classes/:id/cancellations/:date  { reason? }  (admin) cancels one class on one date. */
daysOffRoutes.put('/classes/:id/cancellations/:date', requireRole('admin'), async (req, res) => {
  const classId = param(req.params.id);
  const date = param(req.params.date);
  if (!isDate(date)) throw new HttpError(400, 'Choose a valid date (YYYY-MM-DD).');
  const schoolClass = await getClass(pool, classId);
  if (!schoolClass) throw new HttpError(404, 'Class not found.');
  const raw = req.body?.reason;
  const reason = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 100) : null;

  const removed = await transaction(async (db) => {
    await db.query(
      'INSERT INTO class_cancellations (class_id, date, reason) VALUES ($1, $2, $3) ON CONFLICT (class_id, date) DO UPDATE SET reason = $3',
      [classId, date, reason],
    );
    // Automatic absences already given for that class and day no longer apply.
    const deleted = await db.query("DELETE FROM attendance WHERE class_id = $1 AND date = $2 AND method = 'auto'", [classId, date]);
    await addLog(db, 'info', `${schoolClass.name} cancelled on ${date}${reason ? ` (${reason})` : ''}: no attendance taken`);
    return deleted.rowCount ?? 0;
  });
  res.json({ classId, date, reason, removedAbsences: removed });
});

/** DELETE /api/classes/:id/cancellations/:date  (admin) restores a cancelled class. */
daysOffRoutes.delete('/classes/:id/cancellations/:date', requireRole('admin'), async (req, res) => {
  const classId = param(req.params.id);
  const date = param(req.params.date);
  const removed = await one(pool, 'DELETE FROM class_cancellations WHERE class_id = $1 AND date = $2 RETURNING *', [classId, date]);
  if (!removed) throw new HttpError(404, 'That class is not cancelled on that date.');
  const schoolClass = await getClass(pool, classId);
  await addLog(pool, 'info', `${schoolClass?.name ?? 'Class'} on ${date} restored`);
  res.status(204).end();
});

/** DELETE /api/days-off/:date  (admin) makes the date a normal school day again. */
daysOffRoutes.delete('/days-off/:date', requireRole('admin'), async (req, res) => {
  const date = param(req.params.date);
  const removed = await one<{ date: string; reason: string | null }>(pool, 'DELETE FROM days_off WHERE date = $1 RETURNING *', [date]);
  if (!removed) throw new HttpError(404, 'That date is not a day off.');
  await addLog(pool, 'info', `Day off removed: ${date} is a normal school day again`);
  res.status(204).end();
});
