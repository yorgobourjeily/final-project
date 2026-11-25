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

On first start the API creates the `zeroproxy` database and its tables without sample accounts,
classes or attendance. Open the frontend to create the first administrator; administrators can then
create accounts and classes normally.

| Script            | What it does                                    |
|-------------------|-------------------------------------------------|
| `npm run dev`     | Start with auto-reload (tsx)                    |
| `npm run build`   | Compile TypeScript to `dist/`                   |
| `npm start`       | Run the compiled server                         |
| `npm run scan -- 2 08:05` | Pretend to be the camera machine and send a scan (time optional, default now) |

## Camera machine

The face-recognition machine is a separate program. Enrollment sends a 512-value ArcFace embedding
for a student, and live scans send a camera embedding plus the arrival time. The backend matches the
live embedding against the enrolled student templates, then records attendance. Camera images are
not uploaded.

Enroll or replace a student's template:

```
POST http://<server>:3000/api/face-enrollments
Content-Type: application/json
X-Device-Key: <DEVICE_KEY from .env>

{ "id": "2", "embedding": [/* 512 numeric values from buffalo_l */] }
```

The camera program averages embeddings from the student's reference photos and sends one template.
Its local `student_ids.json` maps each photo-folder name to the student's numeric login ID.

For live attendance, the camera sends the current face encoding instead of an ID:

```
POST http://<server>:3000/api/scans
Content-Type: application/json
X-Device-Key: <DEVICE_KEY from .env>

{ "embedding": [/* 512 numeric values from buffalo_l */], "time": "08:05" }
```

- Existing camera clients may continue sending `{ "id": "2", "time": "08:05" }`.
- Face embeddings are normalized and compared by cosine similarity; the best match must score at least `0.40`.
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

## Database tables

`users`, `face_embeddings` (one face template per student), `classes`, `class_teachers` (many teachers per class), `class_students` (many classes per student),
`parent_children` (many children per parent, many parents per student), `attendance` (one row per student,
per class, per day),
`notifications`, `logs`, `settings`. See `src/schema.ts`.

## API

All routes are under `/api`. Most protected routes need `Authorization: Bearer <token>`; camera
scan and face-enrollment routes accept `X-Device-Key` (or an admin token).

| Method & path                              | Who               | Purpose |
|--------------------------------------------|-------------------|---------|
| `GET  /health`                             | anyone            | Server + database check |
| `GET  /setup/status`                       | anyone            | Reports whether the first administrator still needs to be created |
| `POST /setup/admin`                        | anyone, once      | Creates the first administrator on an empty database |
| `POST /auth/login`                         | anyone            | `{ id, password }` → `{ token, user }` |
| `GET  /auth/me`                            | signed in         | Current user |
| `GET  /state`                              | signed in         | Everything this user may see (users, classes, attendance, notifications, logs) |
| `POST /face-enrollments`                   | camera machine (`X-Device-Key`), admin | `{ id, embedding }` saves or replaces the student's face template |
| `POST /scans`                              | camera machine (`X-Device-Key`), admin | `{ embedding, time }` matches a face template, then saves present/late; `{ id, time }` remains supported |
| `PUT  /classes/:id/attendance/:date`       | teacher, admin    | Submit a class's sheet: `{ entries: [{ studentId, status }] }` (all or nothing) |
| `POST /classes/:id/mark-absent`            | teacher, admin    | `{ date }` marks unmarked students of the class absent |
| `POST /classes`                            | admin             | Create class `{ name, startTime, endTime, lateAfterMinutes, maxAbsences }` |
| `PATCH /classes/:id`                       | admin             | Update class |
| `DELETE /classes/:id`                      | admin             | Delete class |
| `PUT/DELETE /classes/:id/teachers/:teacherId` | admin          | Add / remove a teacher |
| `POST /users`                              | admin             | Create account; its ID is generated (each role counts up from 1: students 1…, parents p1…, teachers t1…, admins a1…; IDs of deleted accounts are never reused) |
| `POST /classes/:id/session/start`          | teacher of the class, admin | Start today's class: the cameras begin taking attendance |
| `POST /classes/:id/session/end`            | teacher of the class, admin | End today's class: students not seen are marked absent |
| `GET  /scan-status`                        | camera machine (`X-Device-Key`), admin | Whether any class is running, so the camera machine knows when to scan |
| `DELETE /users/:id`                        | admin             | Delete account and all its data; alerts about the person are removed and logs keep `[deleted user]` |
| `PUT/DELETE /classes/:id/students/:studentId` | admin          | Add / remove a student (a student can be in several classes) |
| `PUT/DELETE /users/:id/children/:studentId` | admin            | Link / unlink a parent and a student (many-to-many) |
| `POST /notifications/read-all`             | signed in         | Mark own notifications read |
| `POST /logs`                               | signed in         | Report a warning/error to the admin log |

## Rules handled by the server

- A scan after the class's *start time + late minutes* is **late**; the student and every linked parent get an alert in the app.
- When a class ends, each late or absent student and their parents are emailed, once per status. This needs `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM` in `.env` (see `.env.example`) and an email address on the account. Emails are queued in `email_outbox` and sent every 15 seconds; a mail server problem is retried for about 10 minutes, then shown in the log.
- Cameras take attendance only between a teacher's **Start class** and **End class**. When a class ends, students not seen are marked **absent** and parents are messaged. A class never started marks nobody absent.
- A teacher can start and end a class at any time on a day it meets; the class's scheduled end does not stop it. A class left running is closed automatically the next day.
- Teachers of the class are alerted when a student is one absence away from the class's maximum.
- Passwords are stored as bcrypt hashes; logins use JWT tokens (12 hours).
- "Messages" to parents are notifications plus a log entry; no real SMS is sent.
