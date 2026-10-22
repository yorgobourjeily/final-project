# ZeroProxy – Smart Attendance System (frontend)

Angular 20 + TypeScript + HTML + CSS. Data comes from **zeroproxy-backend** (Node.js + Express + PostgreSQL).

## Run

Start the backend first (see `../zeroproxy-backend/README.md`), then:

```bash
npm install
npm start          # http://localhost:4200  (requests to /api are proxied to http://localhost:3000)
```

## Demo accounts

Everyone signs in with their **ID**: students digits only, teachers `t…`, parents `p…`, admins `a…`.

| Role    | ID                          | Password   |
|---------|-----------------------------|------------|
| Admin   | a1                          | admin123   |
| Teacher | t1, t2, t3                  | teacher123 |
| Parent  | p1 … p8                     | parent123  |
| Student | 1 … 8                       | student123 |

Demo classes: **Grade 10 – A** 08:00–14:00 (students 1–3, t1), **Grade 10 – B** 08:00–13:30 (4–6 and 8, t1 + t2) and **Computer Science** 14:30–16:00 (Karim 1, Lea 2 and Elie 5, t3) — so Karim, Lea and Elie are each in two classes. Student 7 has no class yet. Parent `pN` is the parent of student `N`; the Saad family shows the many-to-many links: `p1` (Nadim) and `p8` (Layla) are both parents of `1` (Karim) and `8` (Sara). Student `3` (Jad) is close to the absence limit. New accounts get the next free ID of their role (deleted IDs are reused).

## What each role can do

- **Student**: see today's status in each of their classes (recorded by the classroom camera machine), their student ID, a summary per class and their attendance history.
- **Parent**: for each linked child, see today's status per class, a summary per class and the history; parents are messaged when a child is late or absent.
- **Teacher**: pick one of their classes; type each student's arrival time (present/late is worked out from that class's start time), change the class start time and late limit, edit attendance for any date, see history, get alerts when a student nears the absence limit.
- **Admin**: list, create and delete accounts; create, rename and delete classes; set each class's start/end time, late limit and maximum absences; add any number of teachers and students to each class (a student can be in several classes); link parents and students (several children per parent, several parents per student); check system health, view the activity and error log, reset demo data.

## Notes

- Face recognition runs on a **separate camera machine** (not built yet). When it recognises a student it sends `{ "id": "2", "time": "08:05" }` (student id and time of arrival) to the backend (`POST /api/scans`, see `../zeroproxy-backend/README.md`). Until then, test with **Admin → Camera scanner** or `npm run scan -- 2 08:05` in the backend.
- A scan after the class's *start time + late minutes* is marked **late**. Each class has its own times. Pages refresh every 5 seconds, so scans appear on the teacher's sheet almost immediately.
- Students not marked by that cutoff are set to **absent** automatically by the server (past days: as soon as the teacher opens them). The teacher can change any of them, and a student who scans in later is switched to late.
- Parent "messages" are stored by the backend and recorded in the admin log as "Message sent to …" (no real SMS is sent).
- Code layout: `src/app/api.ts` (calls to the backend, login token), `data.service.ts` (loads data and sends changes), `auth.service.ts`, `guards.ts`, `pages/` (login + 4 portals), `shared/` (tables, status badge, notifications). Each component has its own folder with a `.ts`, `.html` and `.css` file.
