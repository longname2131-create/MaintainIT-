-- Liceo MaintainIT database (SQLite)
-- walay ma wala sa mga tables nga ni delete, instead ma archive sila. morag akong heart sa imoha. <3

CREATE TABLE IF NOT EXISTS roles (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
INSERT OR IGNORE INTO roles (id, name) VALUES (1,'admin'), (2,'student'), (3,'faculty'), (4,'maintenance');

-- Departments / repair teams. The admin routes each complaint to one (a leak goes to Plumbing, internet problems to IT).
-- "keywords" is a comma-separated list used only to SUGGEST a department from the complaint description.
CREATE TABLE IF NOT EXISTS departments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  keywords    TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  archived_at TEXT
);
INSERT OR IGNORE INTO departments (id, name, keywords, created_at) VALUES
  (1, 'Plumbing', 'leak, leaking, leaks, water, pipe, faucet, toilet, sink, drain, clog, clogged, flood, flooded, urinal, flush, plumbing', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  (2, 'IT / Network', 'internet, wifi, wi-fi, network, router, computer, projector, printer, lan, server, monitor, keyboard, software', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  (3, 'Electrical', 'electric, electrical, power, outlet, socket, switch, light, lights, bulb, lamp, wiring, breaker, spark, sparks, fan, blackout', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  (4, 'Carpentry', 'door, lock, window, chair, desk, table, cabinet, wall, hinge, shelf, broken glass', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  (5, 'Air Conditioning', 'aircon, air con, air-con, air condition, air conditioner, hvac, cooling, freon, thermostat', strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  (6, 'Janitorial & General', 'clean, dirty, trash, garbage, smell, pest, cockroach, cockroaches, mop, paint, rats, mice', strftime('%Y-%m-%dT%H:%M:%SZ','now'));

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  phone         TEXT,
  gender        TEXT CHECK (gender IN ('female','male','prefer-not-to-say')),
  role_id       INTEGER NOT NULL REFERENCES roles(id),
  department_id INTEGER REFERENCES departments(id),   -- only used for maintenance staff: which team they belong to
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department_id);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Deri ma hibal-an kung unsa nga user ang nag login, kung successful ba or dili, ug kung unsa ang rason kung dili successful. basin mag pataka raka ba limot limot dayon kas akoa huhu
CREATE TABLE IF NOT EXISTS login_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER REFERENCES users(id),
  email        TEXT NOT NULL,
  success      INTEGER NOT NULL CHECK (success IN (0,1)),
  reason       TEXT,
  ip           TEXT,
  user_agent   TEXT,
  logged_in_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_logs_time  ON login_logs(logged_in_at);
CREATE INDEX IF NOT EXISTS idx_login_logs_email ON login_logs(email, success, logged_in_at);

CREATE TABLE IF NOT EXISTS buildings (
  id   INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE
);
INSERT OR IGNORE INTO buildings (id, code) VALUES (1,'SAC'), (2,'NAC'), (3,'WAC'), (4,'EAC');

CREATE TABLE IF NOT EXISTS complaints (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   TEXT,                -- unique ticket number like C-2026-00012; set when the complaint is created and never changed
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  building_id INTEGER NOT NULL REFERENCES buildings(id),
  floor       TEXT NOT NULL,
  room        TEXT NOT NULL,
  description TEXT NOT NULL,
  photo_file  TEXT,
  status      TEXT NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','In Progress','Resolved')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  resolved_at TEXT,
  archived_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_complaints_ticket ON complaints(ticket_id);
CREATE INDEX IF NOT EXISTS idx_complaints_reporter ON complaints(reporter_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status   ON complaints(status, archived_at);
CREATE INDEX IF NOT EXISTS idx_complaints_building ON complaints(building_id);

-- History satong duha ba nga wala ta mag delete sa complaints, instead ma archive sila. so kung naay changes sa status sa complaint, ma log siya diri. basin mag pataka raka ba limot limot dayon kas akoa huhu
CREATE TABLE IF NOT EXISTS complaint_updates (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id),
  user_id      INTEGER NOT NULL REFERENCES users(id),
  old_status   TEXT,
  new_status   TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_updates_complaint ON complaint_updates(complaint_id);

-- One complaint can be routed to up to 3 departments. Each department has its own assigned worker (assigned_to).
CREATE TABLE IF NOT EXISTS complaint_departments (
  complaint_id  INTEGER NOT NULL REFERENCES complaints(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  assigned_to   INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (complaint_id, department_id)
);
CREATE INDEX IF NOT EXISTS idx_cd_department ON complaint_departments(department_id);

-- Remembers which one-time upgrades already ran on this database.
CREATE TABLE IF NOT EXISTS migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- "Archive instead of delete": kay sakong heart sa imoha, dili nako kaya nga mawala ka sa akong kinabuhi. so instead nga i delete tika, i archive tika. basin mag pataka raka ba limot limot dayon kas akoa huhu
-- In-app notifications (the bell icon). When staff change the status of a complaint, the person who reported it gets a row here.
-- read_at stays empty until they read it. Notifications are never deleted.
CREATE TABLE IF NOT EXISTS notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  complaint_id INTEGER NOT NULL REFERENCES complaints(id),
  message      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  read_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at);
CREATE TRIGGER IF NOT EXISTS no_delete_notifications BEFORE DELETE ON notifications
BEGIN SELECT RAISE(ABORT, 'Notifications cannot be deleted'); END;

-- A ticket ID can be filled in once, but never changed afterwards.
CREATE TRIGGER IF NOT EXISTS ticket_id_fixed BEFORE UPDATE OF ticket_id ON complaints
WHEN OLD.ticket_id IS NOT NULL AND NEW.ticket_id IS NOT OLD.ticket_id
BEGIN SELECT RAISE(ABORT, 'Ticket IDs cannot be changed'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_users BEFORE DELETE ON users
BEGIN SELECT RAISE(ABORT, 'Users are archived, not deleted'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_complaints BEFORE DELETE ON complaints
BEGIN SELECT RAISE(ABORT, 'Complaints are archived, not deleted'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_updates BEFORE DELETE ON complaint_updates
BEGIN SELECT RAISE(ABORT, 'Complaint history cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS no_delete_login_logs BEFORE DELETE ON login_logs
BEGIN SELECT RAISE(ABORT, 'Login logs cannot be deleted'); END;
