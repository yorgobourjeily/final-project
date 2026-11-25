// Tables are created on startup if they don't exist.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  id            int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  max_absences  int NOT NULL DEFAULT 5 CHECK (max_absences >= 1)
);

CREATE TABLE IF NOT EXISTS classes (
  id                  text PRIMARY KEY,
  name                text NOT NULL UNIQUE,
  start_time          text NOT NULL,
  end_time            text NOT NULL,
  late_after_minutes  int  NOT NULL CHECK (late_after_minutes >= 0),
  max_absences        int  NOT NULL CHECK (max_absences >= 1)
);

-- Days of the week the class meets (0 = Sunday … 6 = Saturday). Older databases get Monday–Friday.
ALTER TABLE classes ADD COLUMN IF NOT EXISTS days smallint[] NOT NULL DEFAULT '{1,2,3,4,5}';

-- login_id is the account's ID, used to sign in:
--   student: digits only (e.g. "2", also what the camera machine sends)
--   teacher: "t" + digits, parent: "p" + digits, admin: "a" + digits
CREATE TABLE IF NOT EXISTS users (
  id             text PRIMARY KEY,
  name           text NOT NULL,
  login_id       text NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'teacher', 'parent', 'student')),
  email          text,
  phone          text
);

CREATE TABLE IF NOT EXISTS face_embeddings (
  student_id  text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  embedding   jsonb NOT NULL CHECK (jsonb_typeof(embedding) = 'array' AND jsonb_array_length(embedding) = 512),
  model       text NOT NULL DEFAULT 'buffalo_l',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Databases from before login IDs: students/teachers keep their student/teacher number as their ID.
-- Anyone else is given a new ID on startup (see backfillLoginIds).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'username') THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'student_number') THEN
      EXECUTE 'UPDATE users SET username = student_number WHERE role = ''student'' AND student_number IS NOT NULL';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'teacher_number') THEN
      EXECUTE 'UPDATE users SET username = teacher_number WHERE role = ''teacher'' AND teacher_number IS NOT NULL';
    END IF;
    ALTER TABLE users RENAME COLUMN username TO login_id;
  END IF;
  ALTER TABLE users DROP COLUMN IF EXISTS student_number;
  ALTER TABLE users DROP COLUMN IF EXISTS teacher_number;
END $$;

-- Parents and students: a parent can have many children, and a student many parents.
CREATE TABLE IF NOT EXISTS parent_children (
  parent_id   text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (parent_id, student_id)
);
CREATE INDEX IF NOT EXISTS parent_children_student_idx ON parent_children (student_id);

-- Databases created before parent_children existed had a single users.child_id: move those links over.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'child_id') THEN
    INSERT INTO parent_children (parent_id, student_id)
      SELECT id, child_id FROM users WHERE child_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    ALTER TABLE users DROP COLUMN child_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS class_teachers (
  class_id    text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  teacher_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, teacher_id)
);

-- Students and classes: a student can be in several classes.
CREATE TABLE IF NOT EXISTS class_students (
  class_id    text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  student_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (class_id, student_id)
);
CREATE INDEX IF NOT EXISTS class_students_student_idx ON class_students (student_id);

-- One record per student, per class, per day.
CREATE TABLE IF NOT EXISTS attendance (
  id          text PRIMARY KEY,
  student_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id    text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date        date NOT NULL,
  status      text NOT NULL CHECK (status IN ('present', 'late', 'absent')),
  time        text,
  method      text NOT NULL CHECK (method IN ('face', 'manual', 'auto')),
  CONSTRAINT attendance_student_class_date_key UNIQUE (student_id, class_id, date)
);

-- Databases created when a student had a single users.class_id and one record per day:
-- move class memberships to class_students and give each attendance record its class.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS class_id text REFERENCES classes(id) ON DELETE CASCADE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'class_id') THEN
    INSERT INTO class_students (class_id, student_id)
      SELECT class_id, id FROM users WHERE class_id IS NOT NULL
      ON CONFLICT DO NOTHING;
    UPDATE attendance a SET class_id = u.class_id FROM users u WHERE a.student_id = u.id AND a.class_id IS NULL;
    ALTER TABLE users DROP COLUMN class_id;
  END IF;
  DELETE FROM attendance WHERE class_id IS NULL;
  ALTER TABLE attendance ALTER COLUMN class_id SET NOT NULL;
  ALTER TABLE attendance DROP CONSTRAINT IF EXISTS attendance_student_id_date_key;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_student_class_date_key') THEN
    ALTER TABLE attendance ADD CONSTRAINT attendance_student_class_date_key UNIQUE (student_id, class_id, date);
  END IF;
END $$;

-- School-wide days off (holidays): no class, so no attendance is taken.
CREATE TABLE IF NOT EXISTS days_off (
  date    date PRIMARY KEY,
  reason  text
);

-- One class cancelled on one date: no class, so no attendance is taken for it that day.
CREATE TABLE IF NOT EXISTS class_cancellations (
  class_id  text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date      date NOT NULL,
  reason    text,
  PRIMARY KEY (class_id, date)
);

-- One class running on one date: the teacher pressed Start, and End sets ended_at.
-- Cameras take attendance only in between. Times are HH:mm.
CREATE TABLE IF NOT EXISTS class_sessions (
  class_id    text NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  date        date NOT NULL,
  started_at  text NOT NULL,
  ended_at    text,
  PRIMARY KEY (class_id, date)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  message     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read        boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

-- Emails to students and parents waiting to be sent. Each row is deleted once it is sent, or given up on.
CREATE TABLE IF NOT EXISTS email_outbox (
  id            bigserial PRIMARY KEY,
  recipient_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject       text NOT NULL,
  body          text NOT NULL,
  attempts      int  NOT NULL DEFAULT 0
);
-- Emails the admin writes are not about one student, so student_id can be empty.
ALTER TABLE email_outbox ALTER COLUMN student_id DROP NOT NULL;

-- The late/absent status the family was already emailed about, so ending a class twice does not repeat it.
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS emailed_status text;

CREATE TABLE IF NOT EXISTS logs (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  level    text NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message  text NOT NULL
);

-- The last ID number handed out for each role. It only goes up, so IDs of deleted accounts are never reused.
CREATE TABLE IF NOT EXISTS login_id_counters (
  role         text PRIMARY KEY CHECK (role IN ('admin', 'teacher', 'parent', 'student')),
  last_number  bigint NOT NULL
);
INSERT INTO login_id_counters (role, last_number)
  SELECT role, max(substring(login_id from '[0-9]+$')::bigint) FROM users
  WHERE login_id ~ '^[a-z]?[0-9]{1,12}$'
  GROUP BY role
ON CONFLICT (role) DO UPDATE SET last_number = GREATEST(login_id_counters.last_number, EXCLUDED.last_number);
`;
