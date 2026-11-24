'use strict';
const express = require('express');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.13+, nothing to compile
const bcrypt = require('bcryptjs');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT) || 3000;
const EMAIL_DOMAIN = (process.env.EMAIL_DOMAIN || 'liceo.edu.ph').toLowerCase();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'maintainit.db');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const SESSION_HOURS = 8;
const FLOORS = ['Ground floor', '2nd floor', '3rd floor', '4th floor', '5th floor'];
const STATUSES = ['Open', 'In Progress', 'Resolved'];
const MAX_DEPTS = 3; // most departments one complaint can be sent to
const ROLES = ['admin', 'student', 'faculty', 'maintenance'];

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
// Run fn() as one all-or-nothing database transaction.
db.transaction = (fn) => () => {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
};
// Upgrade a database made by an older version (adds the department columns) before the schema runs.
function addColumnIfMissing(table, column, ddl) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return;
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumnIfMissing('users', 'department_id', 'INTEGER REFERENCES departments(id)');
addColumnIfMissing('complaints', 'ticket_id', 'TEXT');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// Every complaint has a ticket ID. Older complaints get theirs here (only rows that have none are touched).
db.exec(`UPDATE complaints SET ticket_id = 'C-' || strftime('%Y', created_at) || '-' || printf('%05d', id) WHERE ticket_id IS NULL`);

// schema.sql and server.js must be from the same version. Stop with a clear message if schema.sql is out of date.
{
  const have = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name));
  const missing = ['departments', 'complaint_departments', 'migrations', 'notifications'].filter((t) => !have.has(t));
  if (missing.length) {
    console.error(`\n  Your schema.sql is out of date (missing table: ${missing.join(', ')}).`);
    console.error('  Replace schema.sql with the one from the latest liceo-maintainit.zip, then run npm start again.');
    console.error('  Your data is safe: nothing was deleted.\n');
    process.exit(1);
  }
}

// One-time upgrade: complaints used to have ONE department and ONE assignee. Move them into complaint_departments.
if (!db.prepare("SELECT 1 FROM migrations WHERE name = 'complaint-departments'").get()) {
  const cols = new Set(db.prepare('PRAGMA table_info(complaints)').all().map((c) => c.name));
  const deptExpr = cols.has('department_id') ? 'COALESCE(c.department_id, u.department_id)' : 'u.department_id';
  const whoExpr = cols.has('assigned_to') ? 'c.assigned_to' : 'NULL';
  db.transaction(() => {
    if (cols.has('department_id') || cols.has('assigned_to')) {
      db.exec(`INSERT OR IGNORE INTO complaint_departments (complaint_id, department_id, assigned_to, created_at)
               SELECT c.id, ${deptExpr}, ${whoExpr}, c.updated_at FROM complaints c LEFT JOIN users u ON u.id = ${whoExpr}
                WHERE ${deptExpr} IS NOT NULL`);
    }
    db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run('complaint-departments', new Date().toISOString());
  })();
}

const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const roleId = (name) => db.prepare('SELECT id FROM roles WHERE name = ?').get(name).id;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

function createUser({ email, first_name, last_name, phone = null, gender = null, role, password, department_id = null }) {
  const t = now();
  return db.prepare(
    `INSERT INTO users (email, first_name, last_name, phone, gender, role_id, department_id, password_hash, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(email, first_name, last_name, phone, gender, roleId(role), department_id, bcrypt.hashSync(password, 10), t, t).lastInsertRowid;
}

// First run: create the administrator account.
if (!db.prepare('SELECT 1 FROM users WHERE role_id = ?').get(roleId('admin'))) {
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const email = `admin@${EMAIL_DOMAIN}`;
  createUser({ email, first_name: 'System', last_name: 'Administrator', role: 'admin', password });
  console.log('\n  First-run administrator account created');
  console.log(`  Email:    ${email}`);
  console.log(`  Password: ${password}`);
  console.log('  Log in as Staff and change this password right away.\n');
}
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());

// ---------- helpers ----------
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.endsWith('@' + EMAIL_DOMAIN);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function auth(req, res, next) {
  const sid = parseCookies(req).sid;
  const user = sid && db.prepare(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.department_id, r.name AS role
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.archived_at IS NULL`
  ).get(sha(sid), now());
  if (!user) return bad(res, 'Please log in.', 401);
  req.user = user;
  req.sid = sid;
  next();
}
const need = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : bad(res, 'You do not have access to this.', 403);
const isStaff = (u) => u.role === 'admin' || u.role === 'maintenance';

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + MIME_EXT[file.mimetype]),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => (MIME_EXT[file.mimetype] ? cb(null, true) : cb(new Error('BADIMG'))),
});

// ---------- accounts ----------
app.post('/api/register', (req, res) => {
  const b = req.body || {};
  const email = clean(b.email, 200).toLowerCase();
  const first_name = clean(b.first_name, 80);
  const last_name = clean(b.last_name, 80);
  const phone = clean(b.phone, 20);
  const gender = clean(b.gender, 20);
  const role = b.role === 'teacher' ? 'faculty' : clean(b.role, 20);
  const password = String(b.password || '');

  if (!first_name || !last_name) return bad(res, 'Enter your first and last name.');
  if (!emailOk(email)) return bad(res, `Use your Liceo email address (name@${EMAIL_DOMAIN}).`);
  if (!/^[0-9+()\-\s]{7,20}$/.test(phone)) return bad(res, 'Enter a valid phone number.');
  if (!['female', 'male', 'prefer-not-to-say'].includes(gender)) return bad(res, 'Select a gender.');
  if (!['student', 'faculty'].includes(role)) return bad(res, 'Select Student or Faculty.');
  if (password.length < 8 || password.length > 100) return bad(res, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'That email already has an account. Log in instead.', 409);

  createUser({ email, first_name, last_name, phone, gender, role, password });
  res.status(201).json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const email = clean(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password || '');
  const group = clean(req.body?.role, 20); // student | faculty | staff
  const ip = req.socket.remoteAddress || '';
  const ua = clean(req.headers['user-agent'], 200);
  const user = db.prepare(
    `SELECT u.*, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.email = ?`
  ).get(email);
  const log = (ok, reason) =>
    db.prepare(
      'INSERT INTO login_logs (user_id, email, success, reason, ip, user_agent, logged_in_at) VALUES (?,?,?,?,?,?,?)'
    ).run(user ? user.id : null, email.slice(0, 200), ok ? 1 : 0, reason, ip, ua, now());

  const recentFails = db.prepare(
    `SELECT COUNT(*) n FROM login_logs
      WHERE email = ? AND success = 0 AND reason NOT LIKE 'Locked%' AND logged_in_at > ?`
  ).get(email, new Date(Date.now() - 15 * 60 * 1000).toISOString()).n;
  if (recentFails >= 5) {
    log(false, 'Locked: too many attempts');
    return bad(res, 'Too many failed attempts. Try again in 15 minutes.', 429);
  }

  const passOk = bcrypt.compareSync(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !passOk) { log(false, 'Wrong email or password'); return bad(res, 'Wrong email or password.', 401); }
  if (user.archived_at) { log(false, 'Account archived'); return bad(res, 'This account is archived. Contact your administrator.', 403); }
  const groupOk = group === 'staff' ? isStaff(user) : group === user.role;
  if (!groupOk) {
    log(false, 'Wrong role selected');
    const label = isStaff(user) ? 'staff' : user.role;
    return bad(res, `This is a ${label} account. Pick "${isStaff(user) ? 'Staff' : label[0].toUpperCase() + label.slice(1)}" above.`, 403);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const t = now();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(sha(token), user.id, t, new Date(Date.now() + SESSION_HOURS * 3600e3).toISOString());
  log(true, 'OK');
  res.cookie('sid', token, {
    httpOnly: true, sameSite: 'lax', path: '/', maxAge: SESSION_HOURS * 3600e3,
    secure: process.env.COOKIE_SECURE === '1',
  });
  res.json({ user: { id: user.id, email: user.email, first_name: user.first_name, last_name: user.last_name, role: user.role, department_id: user.department_id } });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha(req.sid));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

app.get('/api/meta', auth, (req, res) =>
  res.json({ buildings: db.prepare('SELECT code FROM buildings ORDER BY id').all().map((b) => b.code), floors: FLOORS })
);

// ---------- complaints ----------
const COMPLAINT_SQL = `
  SELECT c.id,
         c.ticket_id,
         b.code AS building, c.floor, c.room, c.description, c.status,
         c.photo_file IS NOT NULL AS has_photo,
         c.created_at, c.updated_at, c.resolved_at, c.archived_at,
         c.reporter_id, u.first_name || ' ' || u.last_name AS reporter, rr.name AS reporter_role
    FROM complaints c
    JOIN buildings b ON b.id = c.building_id
    JOIN users u ON u.id = c.reporter_id
    JOIN roles rr ON rr.id = u.role_id`;

// Adds `departments: [{ id, name, assigned_to, assignee }]` to each complaint row.
function attachDepartments(rows) {
  for (const r of rows) r.departments = [];
  if (!rows.length) return rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const found = db.prepare(
    `SELECT cd.complaint_id, cd.department_id, d.name, cd.assigned_to, u.first_name || ' ' || u.last_name AS assignee
       FROM complaint_departments cd JOIN departments d ON d.id = cd.department_id LEFT JOIN users u ON u.id = cd.assigned_to
      WHERE cd.complaint_id IN (${rows.map(() => '?').join(',')}) ORDER BY d.name`
  ).all(...byId.keys());
  for (const x of found) byId.get(x.complaint_id).departments.push({ id: x.department_id, name: x.name, assigned_to: x.assigned_to, assignee: x.assignee });
  return rows;
}

const canSee = (user, c) => isStaff(user) || c.reporter_id === user.id;

// Guess which department should fix a problem from its description (only a suggestion; the admin decides).
function suggestDepartments(text) {
  const t = ` ${String(text).toLowerCase()} `;
  const scored = [];
  for (const d of db.prepare('SELECT id, keywords FROM departments WHERE archived_at IS NULL ORDER BY id').all()) {
    let score = 0;
    for (const kw of String(d.keywords).split(',').map((k) => k.trim().toLowerCase()).filter(Boolean)) {
      const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // short words must match whole; longer ones match the start of a word (leak -> leaking)
      if (new RegExp(kw.length <= 3 ? `\\b${safe}\\b` : `\\b${safe}`).test(t)) score += kw.length;
    }
    if (score > 0) scored.push({ id: d.id, score });
  }
  return scored.sort((x, y) => y.score - x.score).slice(0, MAX_DEPTS).map((x) => x.id);
}

// The first bytes of a real JPG, PNG, GIF or WebP file. Stops other files that merely claim to be images.
function looksLikeImage(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    fs.readSync(fd, b, 0, 12, 0);
    fs.closeSync(fd);
    return (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
      || b.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n'
      || b.toString('latin1', 0, 4) === 'GIF8'
      || (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP');
  } catch { return false; }
}

app.post('/api/complaints', auth,
  (req, res, next) => upload.single('photo')(req, res, next),
  (req, res) => {
    const b = req.body || {};
    const discard = () => req.file && fs.unlink(req.file.path, () => {});
    const building = db.prepare('SELECT id FROM buildings WHERE code = ?').get(clean(b.building, 10));
    const floor = clean(b.floor, 20);
    const room = clean(b.room, 10);
    const description = clean(b.description, 2000);
    const fi = FLOORS.indexOf(floor);
    if (!building) { discard(); return bad(res, 'Select a building.'); }
    if (fi < 0) { discard(); return bad(res, 'Select a floor.'); }
    if (!/^[1-5]0[1-8]$/.test(room) || Number(room[0]) !== fi + 1) { discard(); return bad(res, 'Select a room on that floor.'); }
    if (description.length < 5) { discard(); return bad(res, 'Describe the problem in a few words.'); }
    if (!req.file) return bad(res, 'Please attach a photo of the problem so staff can see it.');
    if (!looksLikeImage(req.file.path)) { discard(); return bad(res, 'That file is not a real photo. Use a JPG, PNG, WebP or GIF.'); }

    const t = now();
    const id = db.transaction(() => {
      const newId = db.prepare(
        `INSERT INTO complaints (reporter_id, building_id, floor, room, description, photo_file, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(req.user.id, building.id, floor, room, description, req.file ? req.file.filename : null, t, t).lastInsertRowid;
      db.prepare('INSERT INTO complaint_updates (complaint_id, user_id, old_status, new_status, note, created_at) VALUES (?,?,?,?,?,?)')
        .run(newId, req.user.id, null, 'Open', 'Complaint submitted', t);
      db.prepare('UPDATE complaints SET ticket_id = ? WHERE id = ?').run(`C-${t.slice(0, 4)}-${String(newId).padStart(5, '0')}`, newId);
      return newId;
    })();
    const c = attachDepartments([db.prepare(COMPLAINT_SQL + ' WHERE c.id = ?').get(id)])[0];
    res.status(201).json({ complaint: c });
  }
);

app.get('/api/complaints', auth, (req, res) => {
  const where = [];
  const params = [];
  if (!isStaff(req.user)) { where.push('c.reporter_id = ?'); params.push(req.user.id); }
  where.push(req.query.archived === '1' ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL');
  const status = clean(req.query.status, 20);
  if (status === 'active') where.push("c.status != 'Resolved'");
  else if (STATUSES.includes(status)) { where.push('c.status = ?'); params.push(status); }
  const dep = clean(req.query.department, 10);
  if (dep === 'none') where.push('NOT EXISTS (SELECT 1 FROM complaint_departments x WHERE x.complaint_id = c.id)');
  else if (/^\d+$/.test(dep)) { where.push('EXISTS (SELECT 1 FROM complaint_departments x WHERE x.complaint_id = c.id AND x.department_id = ?)'); params.push(Number(dep)); }
  const q = clean(req.query.q, 100);
  if (q) {
    where.push('(c.ticket_id LIKE ? OR c.description LIKE ? OR c.room LIKE ? OR b.code LIKE ? OR u.last_name LIKE ? OR u.first_name LIKE ?)');
    params.push(...Array(6).fill(`%${q}%`));
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const rows = db.prepare(`${COMPLAINT_SQL} WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT ?`).all(...params, limit);
  res.json({ complaints: attachDepartments(rows) });
});

function loadComplaint(req, res) {
  const c = db.prepare(COMPLAINT_SQL + ' WHERE c.id = ?').get(Number(req.params.id));
  if (!c || !canSee(req.user, c)) { bad(res, 'Complaint not found.', 404); return null; }
  attachDepartments([c]);
  return c;
}

app.get('/api/complaints/:id', auth, (req, res) => {
  const c = loadComplaint(req, res);
  if (!c) return;
  // Opening a complaint counts as reading its notifications.
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND complaint_id = ? AND read_at IS NULL').run(now(), req.user.id, c.id);
  const updates = db.prepare(
    `SELECT cu.old_status, cu.new_status, cu.note, cu.created_at, u.first_name || ' ' || u.last_name AS by_name
       FROM complaint_updates cu JOIN users u ON u.id = cu.user_id
      WHERE cu.complaint_id = ? ORDER BY cu.id`
  ).all(c.id);
  res.json({ complaint: c, updates, suggested_department_ids: c.departments.length ? [] : suggestDepartments(c.description) });
});

app.get('/api/complaints/:id/photo', auth, (req, res) => {
  const c = loadComplaint(req, res);
  if (!c) return;
  const row = db.prepare('SELECT photo_file FROM complaints WHERE id = ?').get(c.id);
  if (!row.photo_file) return bad(res, 'No photo.', 404);
  res.sendFile(row.photo_file, { root: UPLOAD_DIR, headers: { 'Content-Security-Policy': "default-src 'none'" } });
});

app.patch('/api/complaints/:id', auth, (req, res) => {
  const c = loadComplaint(req, res);
  if (!c) return;
  if (c.archived_at) return bad(res, 'Restore this complaint before changing it.', 409);
  const b = req.body || {};
  const t = now();

  if (isStaff(req.user)) {
    const notes = [];
    let status = c.status;
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) return bad(res, 'Invalid status.');
      status = b.status;
    }
    const current = db.prepare(
      `SELECT cd.department_id, cd.assigned_to, d.name FROM complaint_departments cd JOIN departments d ON d.id = cd.department_id WHERE cd.complaint_id = ?`
    ).all(c.id);
    const curMap = new Map(current.map((x) => [x.department_id, x]));

    // Admin: choose up to 3 departments and a worker for each one.
    let plan = null;
    if (b.departments !== undefined) {
      if (req.user.role !== 'admin') return bad(res, 'Only the administrator can route a complaint to departments.', 403);
      if (!Array.isArray(b.departments) || b.departments.length > MAX_DEPTS) return bad(res, `Choose at most ${MAX_DEPTS} departments.`);
      plan = [];
      for (const item of b.departments) {
        const did = Number(item && item.id);
        if (!Number.isInteger(did) || plan.some((p) => p.id === did)) return bad(res, 'Pick each department only once.');
        const dd = db.prepare('SELECT id, name, archived_at FROM departments WHERE id = ?').get(did);
        if (!dd || (dd.archived_at && !curMap.has(did))) return bad(res, 'Pick a department.');
        let who = curMap.has(did) ? curMap.get(did).assigned_to : null;
        let whoName = null;
        if (item.assigned_to !== undefined) {
          if (item.assigned_to === null || item.assigned_to === '') who = null;
          else {
            const target = db.prepare(
              `SELECT u.id, u.department_id, r.name AS role, u.first_name || ' ' || u.last_name AS name
                 FROM users u JOIN roles r ON r.id = u.role_id
                WHERE u.id = ? AND r.name IN ('maintenance','admin') AND u.archived_at IS NULL`
            ).get(Number(item.assigned_to));
            if (!target) return bad(res, 'Pick a staff member.');
            if (target.role === 'maintenance' && target.department_id !== did) return bad(res, `${target.name} is not in the ${dd.name} department.`);
            who = target.id;
            whoName = target.name;
          }
        }
        plan.push({ id: did, name: dd.name, who, whoName });
      }
      for (const p of plan) {
        const before = curMap.get(p.id);
        if (!before) notes.push(`Routed to ${p.name}${p.who ? ` (assigned to ${p.whoName})` : ''}`);
        else if (before.assigned_to !== p.who) notes.push(p.who ? `${p.name}: assigned to ${p.whoName}` : `${p.name}: unassigned`);
      }
      for (const x of current) if (!plan.some((p) => p.id === x.department_id)) notes.push(`Removed from ${x.name}`);
    }

    // Maintenance: take (or give back) the job for their own department only.
    let selfChange = null;
    if (b.assigned_to_me !== undefined && req.user.role === 'maintenance') {
      if (!req.user.department_id) return bad(res, 'Ask the administrator to put you in a department first.');
      const row = curMap.get(req.user.department_id);
      if (!row) return bad(res, 'This complaint has not been routed to your department.', 409);
      const want = b.assigned_to_me ? req.user.id : (row.assigned_to === req.user.id ? null : row.assigned_to);
      if (want !== row.assigned_to) {
        selfChange = { id: req.user.department_id, who: want };
        notes.push(want ? `${row.name}: assigned to ${req.user.first_name} ${req.user.last_name}` : `${row.name}: unassigned`);
      }
    }

    const userNote = clean(b.note, 1000);
    const changed = notes.length > 0 || status !== c.status;
    if (userNote) notes.push(userNote);
    if (!changed && !userNote) return bad(res, 'Nothing to update.');

    db.transaction(() => {
      db.prepare('UPDATE complaints SET status = ?, updated_at = ?, resolved_at = ? WHERE id = ?')
        .run(status, t, status === 'Resolved' ? (c.resolved_at || t) : null, c.id);
      // Tell the person who reported it (the bell icon), unless they changed it themselves.
      if (status !== c.status && c.reporter_id !== req.user.id) {
        const what = status === 'Resolved' ? 'has been resolved' : status === 'In Progress' ? 'is now in progress' : 'was reopened';
        db.prepare('INSERT INTO notifications (user_id, complaint_id, message, created_at) VALUES (?,?,?,?)')
          .run(c.reporter_id, c.id, `Your complaint ${c.ticket_id} ${what}.`, t);
      }
      if (plan) {
        for (const x of current) {
          if (!plan.some((p) => p.id === x.department_id)) db.prepare('DELETE FROM complaint_departments WHERE complaint_id = ? AND department_id = ?').run(c.id, x.department_id);
        }
        for (const p of plan) {
          db.prepare(`INSERT INTO complaint_departments (complaint_id, department_id, assigned_to, created_at) VALUES (?,?,?,?)
                      ON CONFLICT(complaint_id, department_id) DO UPDATE SET assigned_to = excluded.assigned_to`).run(c.id, p.id, p.who, t);
        }
      }
      if (selfChange) db.prepare('UPDATE complaint_departments SET assigned_to = ? WHERE complaint_id = ? AND department_id = ?').run(selfChange.who, c.id, selfChange.id);
      db.prepare('INSERT INTO complaint_updates (complaint_id, user_id, old_status, new_status, note, created_at) VALUES (?,?,?,?,?,?)')
        .run(c.id, req.user.id, c.status, status, notes.join('. ') || null, t);
    })();
    return res.json({ ok: true });
  }

  // Reporter: can reword their own complaint while it is still Open.
  if (c.reporter_id !== req.user.id) return bad(res, 'You do not have access to this.', 403);
  if (c.status !== 'Open') return bad(res, 'Only open complaints can be edited.', 409);
  const description = clean(b.description, 2000);
  if (description.length < 5) return bad(res, 'Describe the problem in a few words.');
  db.transaction(() => {
    db.prepare('UPDATE complaints SET description = ?, updated_at = ? WHERE id = ?').run(description, t, c.id);
    db.prepare('INSERT INTO complaint_updates (complaint_id, user_id, old_status, new_status, note, created_at) VALUES (?,?,?,?,?,?)')
      .run(c.id, req.user.id, c.status, c.status, 'Description edited by reporter', t);
  })();
  res.json({ ok: true });
});

function archiveAction(archive) {
  return (req, res) => {
    const c = loadComplaint(req, res);
    if (!c) return;
    const t = now();
    if (archive) {
      if (c.archived_at) return bad(res, 'Already archived.', 409);
      if (req.user.role !== 'admin' && c.status !== 'Resolved') return bad(res, 'Only resolved complaints can be archived.', 409);
      if (req.user.role !== 'admin' && !isStaff(req.user) && c.reporter_id !== req.user.id) return bad(res, 'You do not have access to this.', 403);
    } else if (!c.archived_at) return bad(res, 'This complaint is not archived.', 409);
    db.transaction(() => {
      db.prepare('UPDATE complaints SET archived_at = ?, updated_at = ? WHERE id = ?').run(archive ? t : null, t, c.id);
      db.prepare('INSERT INTO complaint_updates (complaint_id, user_id, old_status, new_status, note, created_at) VALUES (?,?,?,?,?,?)')
        .run(c.id, req.user.id, c.status, c.status, archive ? 'Archived' : 'Restored from archive', t);
    })();
    res.json({ ok: true });
  };
}
app.post('/api/complaints/:id/archive', auth, archiveAction(true));
app.post('/api/complaints/:id/restore', auth, archiveAction(false));

app.get('/api/stats', auth, (req, res) => {
  const mine = !isStaff(req.user);
  const w = mine ? 'AND reporter_id = ?' : '';
  const p = mine ? [req.user.id] : [];
  const one = (sql, ...extra) => db.prepare(sql).get(...p, ...extra);
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  res.json({
    scope: mine ? 'mine' : 'all',
    open: one(`SELECT COUNT(*) n FROM complaints WHERE status != 'Resolved' AND archived_at IS NULL ${w}`).n,
    resolved_month: one(`SELECT COUNT(*) n FROM complaints WHERE status = 'Resolved' AND resolved_at >= ? ${w}`.replace('?', "'" + monthStart + "'")).n,
    avg_days: one(`SELECT ROUND(AVG(julianday(resolved_at) - julianday(created_at)), 1) d FROM complaints WHERE status = 'Resolved' ${w}`).d,
  });
});

app.get('/api/staff', auth, need('admin', 'maintenance'), (req, res) =>
  res.json({
    staff: db.prepare(
      `SELECT u.id, u.first_name || ' ' || u.last_name AS name, r.name AS role, u.department_id, d.name AS department
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN departments d ON d.id = u.department_id
        WHERE r.name IN ('maintenance','admin') AND u.archived_at IS NULL ORDER BY u.first_name`
    ).all(),
  })
);

// ---------- admin ----------
app.get('/api/admin/users', auth, need('admin'), (req, res) =>
  res.json({
    users: db.prepare(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, r.name AS role, u.department_id, d.name AS department, u.created_at, u.archived_at,
              (SELECT MAX(logged_in_at) FROM login_logs l WHERE l.user_id = u.id AND l.success = 1) AS last_login
         FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN departments d ON d.id = u.department_id
        ORDER BY u.archived_at IS NOT NULL, r.id, u.last_name`
    ).all(),
  })
);

app.post('/api/admin/users', auth, need('admin'), (req, res) => {
  const b = req.body || {};
  const email = clean(b.email, 200).toLowerCase();
  const first_name = clean(b.first_name, 80);
  const last_name = clean(b.last_name, 80);
  const role = clean(b.role, 20);
  const password = String(b.password || '');
  if (!first_name || !last_name) return bad(res, 'Enter a first and last name.');
  if (!emailOk(email)) return bad(res, `Use an email ending in @${EMAIL_DOMAIN}.`);
  if (!ROLES.includes(role)) return bad(res, 'Pick a role.');
  if (password.length < 8) return bad(res, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return bad(res, 'That email already has an account.', 409);
  let department_id = null;
  if (role === 'maintenance' && b.department_id !== undefined && b.department_id !== null && b.department_id !== '') {
    const dd = db.prepare('SELECT id FROM departments WHERE id = ? AND archived_at IS NULL').get(Number(b.department_id));
    if (!dd) return bad(res, 'Pick a department.');
    department_id = dd.id;
  }
  createUser({ email, first_name, last_name, role, password, department_id });
  res.status(201).json({ ok: true });
});

app.patch('/api/admin/users/:id', auth, need('admin'), (req, res) => {
  const id = Number(req.params.id);
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!target) return bad(res, 'User not found.', 404);
  const b = req.body || {};
  const self = id === req.user.id;
  const t = now();
  if (b.role !== undefined) {
    if (self) return bad(res, 'You cannot change your own role.', 403);
    if (!ROLES.includes(b.role)) return bad(res, 'Invalid role.');
    db.prepare('UPDATE users SET role_id = ?, updated_at = ? WHERE id = ?').run(roleId(b.role), t, id);
  }
  if (b.archived !== undefined) {
    if (self) return bad(res, 'You cannot archive your own account.', 403);
    db.prepare('UPDATE users SET archived_at = ?, updated_at = ? WHERE id = ?').run(b.archived ? t : null, t, id);
    if (b.archived) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (b.password !== undefined) {
    const pw = String(b.password);
    if (pw.length < 8 || pw.length > 100) return bad(res, 'Password must be at least 8 characters.');
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(bcrypt.hashSync(pw, 10), t, id);
    // Log the user out everywhere, but keep the admin signed in when changing their own password.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(id, self ? sha(req.sid) : '');
  }
  if (b.department_id !== undefined) {
    let dep = null;
    if (b.department_id !== null && b.department_id !== '') {
      const dd = db.prepare('SELECT id FROM departments WHERE id = ? AND archived_at IS NULL').get(Number(b.department_id));
      if (!dd) return bad(res, 'Pick a department.');
      dep = dd.id;
    }
    db.prepare('UPDATE users SET department_id = ?, updated_at = ? WHERE id = ?').run(dep, t, id);
  }
  res.json({ ok: true });
});

app.get('/api/admin/login-logs', auth, need('admin'), (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  res.json({
    logs: db.prepare(
      `SELECT l.id, l.email, l.success, l.reason, l.ip, l.logged_in_at,
              u.first_name || ' ' || u.last_name AS name, r.name AS role
         FROM login_logs l LEFT JOIN users u ON u.id = l.user_id LEFT JOIN roles r ON r.id = u.role_id
        ORDER BY l.id DESC LIMIT ?`
    ).all(limit),
  });
});

// Numbers for the dashboard charts (admin and maintenance staff).
app.get('/api/overview', auth, need('admin', 'maintenance'), (req, res) => {
  const totals = db.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(status = 'Open'), 0) AS open,
            COALESCE(SUM(status = 'In Progress'), 0) AS in_progress,
            COALESCE(SUM(status = 'Resolved'), 0) AS resolved,
            COUNT(DISTINCT reporter_id) AS people,
            ROUND(AVG(CASE WHEN status = 'Resolved' THEN julianday(resolved_at) - julianday(created_at) END), 1) AS avg_days
       FROM complaints`
  ).get();
  const byRole = db.prepare(
    `SELECT r.name AS role, COUNT(DISTINCT c.reporter_id) AS people, COUNT(*) AS complaints
       FROM complaints c JOIN users u ON u.id = c.reporter_id JOIN roles r ON r.id = u.role_id GROUP BY r.name`
  ).all();
  const reported = new Map(db.prepare("SELECT strftime('%Y-%m', created_at) AS m, COUNT(*) AS n FROM complaints GROUP BY m").all().map((x) => [x.m, x.n]));
  const solved = new Map(db.prepare("SELECT strftime('%Y-%m', resolved_at) AS m, COUNT(*) AS n FROM complaints WHERE status = 'Resolved' AND resolved_at IS NOT NULL GROUP BY m").all().map((x) => [x.m, x.n]));
  const today = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const key = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1)).toISOString().slice(0, 7);
    months.push({ month: key, reported: reported.get(key) || 0, solved: solved.get(key) || 0 });
  }
  res.json({ totals, byRole, months });
});

app.get('/api/admin/reports', auth, need('admin'), (req, res) => {
  const q = (sql, ...a) => db.prepare(sql).all(...a);
  res.json({
    totals: db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'Open'), 0) AS open,
              COALESCE(SUM(status = 'In Progress'), 0) AS in_progress,
              COALESCE(SUM(status = 'Resolved'), 0) AS resolved,
              COALESCE(SUM(archived_at IS NOT NULL), 0) AS archived,
              ROUND(AVG(CASE WHEN status = 'Resolved' THEN julianday(resolved_at) - julianday(created_at) END), 1) AS avg_days
         FROM complaints`
    ).get(),
    byBuilding: q(
      `SELECT b.code AS building, COUNT(c.id) AS total, COALESCE(SUM(c.status != 'Resolved'), 0) AS unresolved,
              ROUND(AVG(CASE WHEN c.status = 'Resolved' THEN julianday(c.resolved_at) - julianday(c.created_at) END), 1) AS avg_days
         FROM buildings b LEFT JOIN complaints c ON c.building_id = b.id GROUP BY b.id ORDER BY total DESC`
    ),
    byDepartment: q(
      `SELECT d.name AS department, COUNT(c.id) AS total, COALESCE(SUM(c.status != 'Resolved'), 0) AS unresolved,
              ROUND(AVG(CASE WHEN c.status = 'Resolved' THEN julianday(c.resolved_at) - julianday(c.created_at) END), 1) AS avg_days
         FROM departments d LEFT JOIN complaint_departments x ON x.department_id = d.id LEFT JOIN complaints c ON c.id = x.complaint_id
        WHERE d.archived_at IS NULL OR c.id IS NOT NULL GROUP BY d.id ORDER BY total DESC, d.name`
    ),
    notRouted: db.prepare("SELECT COUNT(*) AS n FROM complaints c WHERE NOT EXISTS (SELECT 1 FROM complaint_departments x WHERE x.complaint_id = c.id) AND c.status != 'Resolved' AND c.archived_at IS NULL").get().n,
    byMonth: q(
      `SELECT strftime('%Y-%m', created_at) AS month, COUNT(*) AS reported, SUM(status = 'Resolved') AS resolved
         FROM complaints GROUP BY month ORDER BY month DESC LIMIT 6`
    ).reverse(),
    hotspots: q(
      `SELECT b.code AS building, c.floor, c.room, COUNT(*) AS total
         FROM complaints c JOIN buildings b ON b.id = c.building_id
        GROUP BY b.code, c.floor, c.room ORDER BY total DESC, b.code LIMIT 5`
    ),
    users: q(`SELECT r.name AS role, COUNT(u.id) AS total FROM roles r LEFT JOIN users u ON u.role_id = r.id AND u.archived_at IS NULL GROUP BY r.id`),
  });
});

app.get('/api/admin/export.csv', auth, need('admin'), (req, res) => {
  const rows = attachDepartments(db.prepare(`${COMPLAINT_SQL} ORDER BY c.id`).all());
  for (const r of rows) {
    r.department_names = r.departments.map((d) => d.name).join('; ');
    r.assigned_staff = r.departments.map((d) => `${d.name}: ${d.assignee || 'unassigned'}`).join('; ');
  }
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  const cols = ['ticket_id', 'building', 'floor', 'room', 'department_names', 'status', 'reporter', 'reporter_role', 'assigned_staff', 'description', 'created_at', 'resolved_at', 'archived_at'];
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="complaints.csv"' }).send('\ufeff' + csv);
});

// ---------- notifications (bell icon) ----------
app.get('/api/notifications', auth, (req, res) => {
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).n;
  const notifications = db.prepare(
    `SELECT id, complaint_id, message, created_at, read_at IS NOT NULL AS is_read
       FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 20`
  ).all(req.user.id);
  res.json({ unread, notifications });
});

app.post('/api/notifications/read-all', auth, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now(), req.user.id);
  res.json({ ok: true });
});

// ---------- departments ----------
app.get('/api/departments', auth, (req, res) => {
  const all = req.user.role === 'admin' && req.query.all === '1';
  res.json({
    departments: db.prepare(
      `SELECT d.id, d.name, d.keywords, d.archived_at,
              (SELECT COUNT(*) FROM users u WHERE u.department_id = d.id AND u.archived_at IS NULL) AS staff,
              (SELECT COUNT(*) FROM complaint_departments x JOIN complaints c ON c.id = x.complaint_id WHERE x.department_id = d.id AND c.status != 'Resolved' AND c.archived_at IS NULL) AS open_complaints
         FROM departments d ${all ? '' : 'WHERE d.archived_at IS NULL'}
        ORDER BY d.archived_at IS NOT NULL, d.name`
    ).all(),
  });
});

const cleanKeywords = (k) =>
  [...new Set(String(k ?? '').split(',').map((x) => x.trim().toLowerCase().slice(0, 40)).filter(Boolean))].slice(0, 60).join(', ');

app.post('/api/admin/departments', auth, need('admin'), (req, res) => {
  const name = clean(req.body?.name, 60);
  if (name.length < 2) return bad(res, 'Enter a department name.');
  if (db.prepare('SELECT 1 FROM departments WHERE name = ?').get(name)) return bad(res, 'That department already exists.', 409);
  db.prepare('INSERT INTO departments (name, keywords, created_at) VALUES (?,?,?)').run(name, cleanKeywords(req.body?.keywords), now());
  res.status(201).json({ ok: true });
});

app.patch('/api/admin/departments/:id', auth, need('admin'), (req, res) => {
  const id = Number(req.params.id);
  if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(id)) return bad(res, 'Department not found.', 404);
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = clean(b.name, 60);
    if (name.length < 2) return bad(res, 'Enter a department name.');
    if (db.prepare('SELECT 1 FROM departments WHERE name = ? AND id != ?').get(name, id)) return bad(res, 'That department already exists.', 409);
    db.prepare('UPDATE departments SET name = ? WHERE id = ?').run(name, id);
  }
  if (b.keywords !== undefined) db.prepare('UPDATE departments SET keywords = ? WHERE id = ?').run(cleanKeywords(b.keywords), id);
  if (b.archived !== undefined) db.prepare('UPDATE departments SET archived_at = ? WHERE id = ?').run(b.archived ? now() : null, id);
  res.json({ ok: true });
});

// ---------- errors ----------
app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err.message === 'BADIMG') return bad(res, 'The photo must be a JPG, PNG, WebP or GIF under 5 MB.');
  if (err.type === 'entity.parse.failed') return bad(res, 'Bad request.');
  console.error(err);
  bad(res, 'Something went wrong on the server.', 500);
});

app.listen(PORT, () => console.log(`Liceo MaintainIT running at http://localhost:${PORT}`));
