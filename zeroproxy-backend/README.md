# ZeroProxy – Backend API

Node.js + Express + TypeScript + PostgreSQL. Serves the data for `zeroproxy-frontend`.

## Setup

1. PostgreSQL must be running (default `localhost:5432`).
2. Copy `.env.example` to `.env` and set `PGPASSWORD` to your `postgres` user's password.
3. Install and run:

```bash
npm install
npm run dev        # http://localhost:3000
```

On first start the API creates the `zeroproxy` database and its tables, and loads demo data
(same demo accounts as the frontend README). `npm run reset-db` wipes everything and reloads the demo data.

| Script            | What it does                                    |
|-------------------|-------------------------------------------------|
| `npm run dev`     | Start with auto-reload (tsx)                    |
| `npm run build`   | Compile TypeScript to `dist/`                   |
| `npm start`       | Run the compiled server                         |
| `npm run reset-db`| Delete all data and reload the demo data        |
| `npm run scan -- 2 08:05` | Pretend to be the camera machine and send a scan (time optional, default now) |

## Camera machine

The face-recognition machine is a separate program. When it recognises a student it sends their
**id and time of arrival**:

```
POST http://<server>:3000/api/scans
Content-Type: application/json
X-Device-Key: <DEVICE_KEY from .env>

{ "id": "2", "time": "08:05" }
```

- `id`: digits only (string or number).
- `time`: `"08:05"`, `"08:05:30"` or a full date-time; must be today and not in the future.

A student can be in several classes. The scan counts for the student's **earliest class today that has
not ended yet and that they are not marked for yet** (e.g. 07:55 → Grade 10 – A, 14:35 → Computer Science).
The API compares the arrival time with that class's cutoff (*start time + late minutes*) and saves
**present** (at or before the cutoff) or **late** (after it). Late arrivals message the parents.

| Reply | Meaning |
|-------|---------|
| `201` | Saved. Body: `{ student: { name, id, class }, date, time, lateAfter, minutesLate, status, alreadyMarked: false, message }` |
| `200` | Already marked for the running class (`alreadyMarked: true`), nothing changed |
| `400` | Missing/invalid id or time, or no class still running at that time |
| `404` | No student has that id |
| `401` | Wrong or missing `X-Device-Key` |

Example reply:
```json
{ "student": { "name": "Karim Saad", "id": "1", "class": "Grade 10 – A" }, "date": "2026-10-22",
  "time": "08:25", "lateAfter": "08:10", "minutesLate": 15, "status": "late", "alreadyMarked": false,
  "message": "Karim Saad arrived at 08:25 for Grade 10 – A, 15 min after 08:10: late." }
```

Demo student IDs: `1` … `8` (see the admin's User accounts or Camera scanner tab).

## Database tables

`users`, `classes`, `class_teachers` (many teachers per class), `class_students` (many classes per student),
`parent_children` (many children per parent, many parents per student), `attendance` (one row per student,
per class, per day),
`notifications`, `logs`, `settings`. See `src/schema.ts`.

## API

All routes are under `/api`. Except login and health, they need `Authorization: Bearer <token>`.

| Method & path                              | Who               | Purpose |
|--------------------------------------------|-------------------|---------|
| `GET  /health`                             | anyone            | Server + database check |
| `POST /auth/login`                         | anyone            | `{ id, password }` → `{ token, user }` (id: `2`, `t1`, `p2`, `a1`) |
| `GET  /auth/me`                            | signed in         | Current user |
| `GET  /state`                              | signed in         | Everything this user may see (users, classes, attendance, notifications, logs) |
| `POST /scans`                              | camera machine (`X-Device-Key`), admin | `{ id, time }` from the camera: compares the arrival time and saves present/late |
| `PUT  /classes/:id/attendance/:date`       | teacher, admin    | Submit a class's sheet: `{ entries: [{ studentId, status } \| { studentId, time }] }` (all or nothing) |
| `POST /classes/:id/mark-absent`            | teacher, admin    | `{ date }` marks unmarked students of the class absent |
| `POST /classes`                            | admin             | Create class `{ name, startTime, endTime, lateAfterMinutes, maxAbsences }` |
| `PATCH /classes/:id`                       | admin, teacher*   | Update class (*teachers: times and late minutes only) |
| `DELETE /classes/:id`                      | admin             | Delete class |
| `PUT/DELETE /classes/:id/teachers/:teacherId` | admin          | Add / remove a teacher |
| `POST /users`                              | admin             | Create account; its ID is generated (each role counts up from 1: students 1…, parents p1…, teachers t1…, admins a1…; the lowest free ID is used, so IDs of deleted accounts are reused) |
| `DELETE /users/:id`                        | admin             | Delete account |
| `PUT/DELETE /classes/:id/students/:studentId` | admin          | Add / remove a student (a student can be in several classes) |
| `PUT/DELETE /users/:id/children/:studentId` | admin            | Link / unlink a parent and a student (many-to-many) |
| `POST /notifications/read-all`             | signed in         | Mark own notifications read |
| `POST /logs`                               | signed in         | Report a warning/error to the admin log |
| `POST /admin/reset`                        | admin             | Reload demo data |

## Rules handled by the server

- A scan or arrival time after the class's *start time + late minutes* is **late**; every linked parent gets a message.
- Every minute, students who haven't scanned in by their class's late cutoff are marked **absent** (weekdays), and parents are messaged.
- Teachers of the class are alerted when a student is one absence away from the class's maximum.
- Passwords are stored as bcrypt hashes; logins use JWT tokens (12 hours).
- "Messages" to parents are notifications plus a log entry; no real SMS is sent.
