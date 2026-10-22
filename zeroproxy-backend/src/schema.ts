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

CREATE TABLE IF NOT EXISTS notifications (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  message     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read        boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS logs (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  level    text NOT NULL CHECK (level IN ('info', 'warning', 'error')),
  message  text NOT NULL
);
`;
