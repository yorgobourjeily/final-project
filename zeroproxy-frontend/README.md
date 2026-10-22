# ZeroProxy – Smart Attendance System (frontend only)

Angular 20 + TypeScript + HTML + CSS. No backend: all data is stored in the browser (localStorage).

## Run

```bash
npm install
npm start          # http://localhost:4200
```

## Demo accounts

| Role    | Username            | Password   |
|---------|---------------------|------------|
| Admin   | admin               | admin123   |
| Teacher | teacher             | teacher123 |
| Parent  | parent1 … parent7   | parent123  |
| Student | student1 … student7 | student123 |

`parentN` is the parent of `studentN`. `student3` (Jad) is close to the absence limit; `student7` (Rami) is not on the class sheet yet.

## What each role can do

- **Student**: scan face with the camera to mark attendance, see history and notifications.
- **Parent**: see their child's history; get a notification (and simulated SMS) when the child is late or absent.
- **Teacher**: type each student's arrival time (present/late is worked out automatically), set the class start time and late limit, edit attendance or lateness for any date, mark unmarked students absent, see history, get alerts when a student nears the absence limit, add/remove students from the class sheet.
- **Admin**: list, create and delete accounts, set class start time / late threshold / absence limit, check system health, view the activity and error log, reset demo data.

## Notes

- Face recognition is **simulated**: the camera opens and captures a frame, but identifying a face needs a trained model or server. The logged-in student is the one marked.
- A scan after *start time + late minutes* (default 08:00 + 10 min) is marked **late**.
- Students not marked by that cutoff are set to **absent** automatically (past days: as soon as the teacher opens them). The teacher can change any of them, and a student who scans in later is switched to late.
- Parent "messages" appear in the parent portal and are recorded in the admin log as "Message sent to …".
- Code layout: `src/app/data.service.ts` (all data and rules), `db.ts` (alerts + demo data), `auth.service.ts`, `guards.ts`, `pages/` (login + 4 portals), `shared/` (camera, tables, notifications). Each component has its own folder with a `.ts`, `.html` and `.css` file.
