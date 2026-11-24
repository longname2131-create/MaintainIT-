'use strict';
const FLOORS = ['Ground floor', '2nd floor', '3rd floor', '4th floor', '5th floor'];
const ROLE_LABEL = { admin: 'Administrator', student: 'Student', faculty: 'Faculty', maintenance: 'Maintenance staff' };
const app = document.getElementById('app');
const dlg = document.getElementById('dlg');
let me = null;
let meta = { buildings: [], floors: FLOORS };
let notice = '';

// ---------- helpers ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const fmt = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const slug = (s) => String(s).toLowerCase().replace(/\s+/g, '-');
const badge = (s) => `<span class="badge s-${slug(s)}">${esc(s)}</span>`;
const isStaff = () => me.role === 'admin' || me.role === 'maintenance';

async function api(url, opts = {}) {
  const o = { credentials: 'same-origin', ...opts };
  if (o.body && !(o.body instanceof FormData)) {
    o.headers = { 'Content-Type': 'application/json', ...(o.headers || {}) };
    o.body = JSON.stringify(o.body);
  }
  const r = await fetch(url, o);
  let d = {};
  try { d = await r.json(); } catch { /* non-JSON response */ }
  if (!r.ok) throw Object.assign(new Error(d.error || 'Something went wrong. Try again.'), { status: r.status });
  return d;
}

function say(el, text, ok = false) {
  el.textContent = text;
  el.className = 'msg ' + (text ? (ok ? 'ok' : 'err') : '');
}


// In-page replacements for alert() and prompt(), which some viewers (like VS Code's browser) block silently.
function notify(msg) {
  dlg.innerHTML = `<div class="dlg-in"><p>${esc(msg)}</p><p><button class="btn small" id="ok">OK</button></p></div>`;
  if (!dlg.open) dlg.showModal();
  $('#ok', dlg).addEventListener('click', () => dlg.close());
}
function askPassword(label) {
  return new Promise((resolve) => {
    dlg.innerHTML = `<div class="dlg-in"><form id="pf" novalidate><h3>Reset password</h3>
      <p class="hint">Choose a new password for ${esc(label)}.</p>
      <label for="np">New password (at least 8 characters)</label>
      <input id="np" type="text" autocomplete="off" required>
      <p class="row"><button class="btn" type="submit">Save password</button><button class="btn ghost" type="button" id="pc">Cancel</button></p>
      <div class="msg" id="pm" role="status"></div></form></div>`;
    let settled = false;
    const finish = (v) => { if (settled) return; settled = true; dlg.removeEventListener('close', onClose); if (dlg.open) dlg.close(); resolve(v); };
    const onClose = () => finish(null);
    dlg.addEventListener('close', onClose);
    if (!dlg.open) dlg.showModal();
    $('#np', dlg).focus();
    $('#pc', dlg).addEventListener('click', () => finish(null));
    $('#pf', dlg).addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('#np', dlg).value;
      if (v.length < 8) return say($('#pm', dlg), 'Use at least 8 characters.');
      finish(v);
    });
  });
}

// logo falls back to an "L" if public/ldcu.jpg.png is missing
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG' && e.target.closest('.logo')) e.target.closest('.logo').classList.add('noimg');
}, true);
const logo = () => '<span class="logo"><img src="/ldcu.jpg.png" alt="Liceo logo"><b>L</b></span>';

// ---------- notification bell ----------
const BELL_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
let notifState = { unread: 0, items: [] };
let notifOwner = null;
let notifTimer = null;

const bellHtml = () => `<div class="bellwrap">
  <button class="bell" id="bell" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="bellpanel" aria-label="Notifications">${BELL_ICON}<span class="bellcount" id="bellcount" hidden>0</span></button>
  <div class="bellpanel" id="bellpanel" role="region" aria-label="Notifications" hidden>
    <div class="bellhead"><strong>Notifications</strong><button type="button" class="btn ghost small" id="markall">Mark all as read</button></div>
    <ul class="bellist" id="bellist"></ul>
  </div></div>`;

function renderBell() {
  const btn = $('#bell');
  if (!btn) return;
  const n = notifState.unread;
  btn.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  const count = $('#bellcount');
  count.hidden = !n;
  count.textContent = n > 99 ? '99+' : String(n);
  $('#bellist').innerHTML = notifState.items.length
    ? notifState.items.map((it) => `<li><button type="button" class="nitem ${it.is_read ? '' : 'unread'}" data-nc="${it.complaint_id}"><span>${esc(it.message)}</span><small>${fmt(it.created_at)}</small></button></li>`).join('')
    : '<li class="nempty">No notifications yet.</li>';
  $('#markall').disabled = !n;
}

async function refreshNotifications() {
  if (!me) return;
  try {
    const d = await api('/api/notifications');
    notifState = { unread: d.unread, items: d.notifications };
    renderBell();
  } catch { /* keep showing the old numbers */ }
}

function closeBell() {
  const p = $('#bellpanel');
  if (p) p.hidden = true;
  const b = $('#bell');
  if (b) b.setAttribute('aria-expanded', 'false');
}

function wireBell() {
  if (notifOwner !== me.id) { notifState = { unread: 0, items: [] }; notifOwner = me.id; } // never show another user's numbers
  renderBell();
  $('#bell').addEventListener('click', () => {
    const p = $('#bellpanel');
    const open = p.hidden;
    p.hidden = !open;
    $('#bell').setAttribute('aria-expanded', String(open));
    if (open) refreshNotifications();
  });
  $('#bellist').addEventListener('click', (e) => {
    const b = e.target.closest('[data-nc]');
    if (b) { closeBell(); openDetail(b.dataset.nc); }
  });
  $('#markall').addEventListener('click', async () => {
    try { await api('/api/notifications/read-all', { method: 'POST' }); } catch { /* ignore */ }
    refreshNotifications();
  });
  refreshNotifications();
  clearInterval(notifTimer);
  notifTimer = setInterval(refreshNotifications, 30000);
}
document.addEventListener('click', (e) => { if (!e.target.closest('.bellwrap')) closeBell(); });
document.addEventListener('keydown', (e) => {
  const p = $('#bellpanel');
  if (e.key === 'Escape' && p && !p.hidden) { closeBell(); $('#bell').focus(); }
});
window.addEventListener('focus', refreshNotifications);

// ---------- login / sign-up ----------
function loginView() {
  app.innerHTML = `
  <div class="auth-wrap"><main class="auth">
    <div class="brand">${logo()} Liceo MaintainIT</div>
    <h1>Welcome back</h1>
    <p class="intro">Log in to report a problem or follow its progress.</p>
    <form id="f" novalidate>
      <fieldset><legend>Log in as</legend>
        <div class="role-options">
          <label><input type="radio" name="role" value="student" required><span>Student</span></label>
          <label><input type="radio" name="role" value="faculty"><span>Faculty</span></label>
          <label><input type="radio" name="role" value="staff"><span>Staff</span></label>
        </div>
      </fieldset>
      <label for="email">Liceo email address</label>
      <input id="email" type="email" placeholder="JohnDoe1234@liceo.edu.ph" autocomplete="email" required>
      <div class="pw-row"><label for="pw">Password</label><a href="#" id="forgot">Forgot password?</a></div>
      <div class="pw-control">
        <input id="pw" type="password" placeholder="Enter your password" autocomplete="current-password" required>
        <button class="btn ghost" id="tog" type="button" aria-pressed="false">Show</button>
      </div>
      <button class="btn full" type="submit">Log in</button>
      <div class="msg" id="msg" role="status" aria-live="polite"></div>
    </form>
    <p class="switch">New to Liceo MaintainIT? <a href="#/signup">Create an account</a></p>
  </main></div>`;
  const f = $('#f'), msg = $('#msg');
  if (notice) { say(msg, notice, true); notice = ''; }
  $('#tog').addEventListener('click', (e) => {
    const show = $('#pw').type === 'password';
    $('#pw').type = show ? 'text' : 'password';
    e.target.textContent = show ? 'Hide' : 'Show';
    e.target.setAttribute('aria-pressed', String(show));
  });
  $('#forgot').addEventListener('click', (e) => {
    e.preventDefault();
    say(msg, 'Ask your school administrator to reset your password.');
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = (f.querySelector('input[name=role]:checked') || {}).value;
    if (!role) return say(msg, 'Choose whether you are a student, faculty or staff.');
    if (!f.reportValidity()) return;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const d = await api('/api/login', { method: 'POST', body: { role, email: $('#email').value, password: $('#pw').value } });
      me = d.user;
      meta = await api('/api/meta');
      location.hash = '#/dashboard';
      route();
    } catch (err) { say(msg, err.message); btn.disabled = false; }
  });
}

function signupView() {
  app.innerHTML = `
  <div class="auth-wrap"><main class="auth wide">
    <div class="brand">${logo()} Liceo MaintainIT</div>
    <h1>Create your account</h1>
    <p class="intro">Use your Liceo email. Maintenance staff accounts are created by the administrator.</p>
    <form id="f" novalidate>
      <div class="grid2">
        <div><label for="fn">First name</label><input id="fn" autocomplete="given-name" required></div>
        <div><label for="ln">Last name</label><input id="ln" autocomplete="family-name" required></div>
        <div><label for="em">Liceo email address</label><input id="em" type="email" autocomplete="email" required></div>
        <div><label for="ph">Phone number</label><input id="ph" type="tel" autocomplete="tel" required></div>
        <div><label for="gd">Gender</label><select id="gd" required><option value="">Select a gender</option><option value="female">Female</option><option value="male">Male</option><option value="prefer-not-to-say">Prefer not to say</option></select></div>
        <div><label for="rl">I am a</label><select id="rl" required><option value="">Select a role</option><option value="student">Student</option><option value="faculty">Faculty</option></select></div>
        <div><label for="p1">Password (at least 8 characters)</label><input id="p1" type="password" minlength="8" autocomplete="new-password" required></div>
        <div><label for="p2">Confirm password</label><input id="p2" type="password" minlength="8" autocomplete="new-password" required></div>
      </div>
      <button class="btn full" type="submit">Create account</button>
      <div class="msg" id="msg" role="status" aria-live="polite"></div>
    </form>
    <p class="switch">Already have an account? <a href="#/login">Log in</a></p>
  </main></div>`;
  const f = $('#f'), msg = $('#msg');
  const same = () => $('#p2').setCustomValidity($('#p2').value && $('#p1').value !== $('#p2').value ? 'Passwords do not match.' : '');
  $('#p1').addEventListener('input', same);
  $('#p2').addEventListener('input', same);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    same();
    if (!f.reportValidity()) return;
    const btn = f.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await api('/api/register', { method: 'POST', body: {
        first_name: $('#fn').value, last_name: $('#ln').value, email: $('#em').value, phone: $('#ph').value,
        gender: $('#gd').value, role: $('#rl').value, password: $('#p1').value } });
      notice = 'Account created. Log in below.';
      location.hash = '#/login';
    } catch (err) { say(msg, err.message); btn.disabled = false; }
  });
}

// ---------- app shell ----------
function navItems() {
  const items = [
    ['dashboard', '▦', 'Dashboard'],
    ['complaints', '⚠', isStaff() ? 'All complaints' : 'My complaints'],
    ['archive', '▤', 'Archive'],
  ];
  if (me.role === 'admin') items.push(['sep', '', 'Administration'], ['users', '☺', 'Users'], ['departments', '⚒', 'Departments'], ['logs', '⏲', 'Login logs'], ['reports', '▥', 'Reports']);
  items.push(['sep', '', 'Support'], ['help', '� ', 'Help Center']);
  return items;
}

function shell(active, title, subtitle) {
  app.innerHTML = `
  <div class="layout">
    <aside>
      <div class="side-brand">${logo()}<div><h1>MaintainIT</h1><small>${esc(ROLE_LABEL[me.role])}</small></div></div>
      <nav aria-label="Main">${navItems().map(([k, icon, label]) =>
        k === 'sep' ? `<div class="sep">${esc(label)}</div>` :
        `<a href="#/${k}" class="${k === active ? 'active' : ''}"${k === active ? ' aria-current="page"' : ''}>${icon} <span>${esc(label)}</span></a>`).join('')}
      </nav>
    </aside>
    <main class="content">
      <header class="top">
        <div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>
        <div class="who">${bellHtml()}<div class="avatar">${esc(me.first_name[0])}</div><div>${esc(me.first_name)} ${esc(me.last_name)}<small>${esc(me.email)}</small></div>
          <button class="btn ghost small" id="logout">Log out</button></div>
      </header>
      <div id="view"></div>
    </main>
  </div>`;
  wireBell();
  $('#logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch { /* already logged out */ }
    me = null;
    location.hash = '#/login';
    route();
  });
  return $('#view');
}

// ---------- complaints table + detail dialog ----------
function complaintsTable(rows) {
  if (!rows.length) return '<p class="empty">No complaints here yet.</p>';
  return `<div class="scroll"><table><thead><tr><th>Ticket ID</th><th>Location</th><th>Problem</th><th>Status</th><th>Department</th>${isStaff() ? '<th>Reported by</th><th>Assigned to</th>' : ''}<th>Reported</th><th></th></tr></thead><tbody>${rows.map((c) => `
    <tr class="${c.archived_at ? 'archived' : ''}">
      <td><span class="ticket">${esc(c.ticket_id)}</span></td>
      <td>${esc(c.building)} · ${esc(c.floor)} · ${esc(c.room)}</td>
      <td>${esc(c.description.length > 70 ? c.description.slice(0, 70) + '…' : c.description)}</td>
      <td>${badge(c.status)}</td>
      <td>${esc(c.departments.map((x) => x.name).join(', ') || '—')}</td>
      ${isStaff() ? `<td>${esc(c.reporter)}<br><small>${esc(ROLE_LABEL[c.reporter_role])}</small></td><td>${esc(c.departments.map((x) => x.assignee).filter(Boolean).join(', ') || '—')}</td>` : ''}
      <td>${fmt(c.created_at)}</td>
      <td><button class="btn ghost small" data-open="${c.id}">View</button></td>
    </tr>`).join('')}</tbody></table></div>`;
}

function bindOpen(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openDetail(b.dataset.open);
  });
}

async function openDetail(id) {
  let d, staff = [], depts = [];
  try {
    d = await api('/api/complaints/' + id);
    if (isStaff()) {
      staff = (await api('/api/staff')).staff;
      depts = (await api('/api/departments')).departments;
    }
  } catch (err) {
    if ((err.status === 401 || err.status === 403) && (await syncSession())) {
      return notify(me ? `You are now signed in as ${me.first_name} (${ROLE_LABEL[me.role]}) because another tab logged in with a different account.` : 'Your session ended. Log in again.');
    }
    return notify(err.message);
  }
  const MAX = 3; // most departments one complaint can have
  const c = d.complaint;
  refreshNotifications(); // opening a complaint marks its notifications as read
  const admin = me.role === 'admin';
  const suggested = c.departments.length ? [] : (d.suggested_department_ids || []).map((i) => depts.find((x) => x.id === i)).filter(Boolean);
  const allDepts = depts.slice();
  for (const x of c.departments) if (!allDepts.some((y) => y.id === x.id)) allDepts.push({ id: x.id, name: x.name + ' (archived)' });
  const canArchive = !c.archived_at && (me.role === 'admin' || (c.status === 'Resolved' && (isStaff() || c.reporter_id === me.id)));
  const canEdit = !isStaff() && c.reporter_id === me.id && c.status === 'Open' && !c.archived_at;
  const myRow = c.departments.find((x) => x.id === me.department_id);
  const editable = isStaff() && !c.archived_at;

  dlg.innerHTML = `<div class="dlg-in">
    <div class="dlg-head"><h3><span class="ticket">${esc(c.ticket_id)}</span> ${badge(c.status)}</h3><button class="btn ghost small" id="x">Close</button></div>
    <dl class="facts">
      <dt>Ticket ID</dt><dd><span class="ticket">${esc(c.ticket_id)}</span></dd>
      <dt>Location</dt><dd>${esc(c.building)} · ${esc(c.floor)} · Room ${esc(c.room)}</dd>
      <dt>Reported by</dt><dd>${esc(c.reporter)} (${esc(ROLE_LABEL[c.reporter_role])})</dd>
      <dt>Reported</dt><dd>${fmt(c.created_at)}</dd>
      <dt>Departments</dt><dd>${c.departments.length ? c.departments.map((x) => `${esc(x.name)} — ${esc(x.assignee || 'nobody assigned yet')}`).join('<br>') : 'Not routed yet'}</dd>
      ${c.resolved_at ? `<dt>Resolved</dt><dd>${fmt(c.resolved_at)}</dd>` : ''}
      ${c.archived_at ? `<dt>Archived</dt><dd>${fmt(c.archived_at)}</dd>` : ''}
    </dl>
    <div class="desc">${esc(c.description)}</div>
    ${c.has_photo ? `<img class="photo" src="/api/complaints/${c.id}/photo" alt="Photo of the problem">` : ''}
    <h4>History</h4>
    <ul class="history">${d.updates.map((u) => `<li><strong>${esc(u.by_name)}</strong> <small>${fmt(u.created_at)}</small><br>
      ${u.old_status !== u.new_status ? `${u.old_status ? esc(u.old_status) + ' → ' : ''}${esc(u.new_status)}${u.note ? ' · ' : ''}` : ''}${esc(u.note || '')}</li>`).join('')}</ul>
    ${editable ? `<form class="dlg-actions" id="upd">
      <div class="row"><div><label for="st">Status</label><select id="st">${['Open', 'In Progress', 'Resolved'].map((s) => `<option ${s === c.status ? 'selected' : ''}>${s}</option>`).join('')}</select></div></div>
      ${admin ? `<fieldset class="deptbox"><legend>Departments (up to ${MAX}) and who handles each</legend>
          <div id="drows"></div>
          ${suggested.length ? `<p class="hint" id="sgbox">Suggested from the description: <strong>${esc(suggested.map((x) => x.name).join(', '))}</strong> <button type="button" class="btn ghost small" id="usesg">Use suggestion</button></p>` : ''}
          <p><button type="button" class="btn ghost small" id="addd">+ Add department</button></p></fieldset>`
        : myRow ? `<label class="check"><input type="checkbox" id="me" ${myRow.assigned_to === me.id ? 'checked' : ''}> I am handling this for ${esc(myRow.name)}</label>`
        : `<p class="hint">${c.departments.length ? 'This complaint is not routed to your department, so only the administrator can assign it.' : 'The administrator has not routed this complaint yet.'}</p>`}
      <label for="nt">Note (optional)</label><textarea id="nt" maxlength="1000" placeholder="What was done, or what is needed?"></textarea>
      <p class="row" style="margin-top:14px"><button class="btn" type="submit">Save update</button></p>
      <div class="msg" id="m" role="status"></div></form>` : ''}
    ${canEdit ? `<form class="dlg-actions" id="edit"><label for="ed">Edit your description</label><textarea id="ed" maxlength="2000">${esc(c.description)}</textarea>
      <p><button class="btn" type="submit">Save changes</button></p><div class="msg" id="m" role="status"></div></form>` : ''}
    <div class="dlg-actions">
      ${canArchive ? '<button class="btn maroon small" id="arch">Archive</button>' : ''}
      ${c.archived_at ? '<button class="btn small" id="rest">Restore</button>' : ''}
    </div></div>`;
  dlg.showModal();

  // Admin: department rows, each with its own worker list (only people from that department).
  let rows = c.departments.map((x) => ({ id: x.id, assigned_to: x.assigned_to }));
  const deptOptions = (i) => '<option value="">Select department…</option>' + allDepts
    .filter((x) => x.id === rows[i].id || !rows.some((o) => o.id === x.id))
    .map((x) => `<option value="${x.id}" ${x.id === rows[i].id ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  const whoOptions = (i) => {
    const r = rows[i];
    if (!r.id) return '<option value="">Nobody</option>';
    return '<option value="">Nobody</option>' + staff.filter((s) => s.department_id === r.id || s.id === r.assigned_to)
      .map((s) => `<option value="${s.id}" ${s.id === r.assigned_to ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  };
  function renderRows() {
    const box = $('#drows', dlg);
    if (!box) return;
    box.innerHTML = rows.length ? rows.map((r, i) => `<div class="row drow">
      <div><label>Department ${i + 1}</label><select data-dsel="${i}" aria-label="Department ${i + 1}">${deptOptions(i)}</select></div>
      <div><label>Assigned to</label><select data-who="${i}" aria-label="Worker for department ${i + 1}" ${r.id ? '' : 'disabled'}>${whoOptions(i)}</select></div>
      <button type="button" class="btn ghost small" data-rm="${i}">Remove</button></div>`).join('')
      : '<p class="hint">Not routed yet. Add a department below.</p>';
    $('#addd', dlg).disabled = rows.length >= MAX;
  }
  if (editable && admin) {
    renderRows();
    $('#drows', dlg).addEventListener('change', (e) => {
      const ds = e.target.closest('[data-dsel]'), wh = e.target.closest('[data-who]');
      if (ds) { const i = Number(ds.dataset.dsel); rows[i].id = Number(ds.value) || null; rows[i].assigned_to = null; renderRows(); }
      if (wh) rows[Number(wh.dataset.who)].assigned_to = Number(wh.value) || null;
    });
    $('#drows', dlg).addEventListener('click', (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { rows.splice(Number(rm.dataset.rm), 1); renderRows(); }
    });
    $('#addd', dlg).addEventListener('click', () => { if (rows.length < MAX) { rows.push({ id: null, assigned_to: null }); renderRows(); } });
    const sg = $('#usesg', dlg);
    if (sg) sg.addEventListener('click', () => {
      rows = suggested.slice(0, MAX).map((x) => ({ id: x.id, assigned_to: null }));
      renderRows();
      const box = $('#sgbox', dlg);
      if (box) box.remove();
    });
  }

  const done = () => { dlg.close(); route(); };
  $('#x', dlg).addEventListener('click', () => dlg.close());
  const act = (sel, fn) => { const el = $(sel, dlg); if (el) el.addEventListener(sel === '#upd' || sel === '#edit' ? 'submit' : 'click', async (e) => {
    e.preventDefault();
    const m = $('#m', dlg);
    try { await fn(); done(); } catch (err) { if (m) say(m, err.message); else notify(err.message); }
  }); };
  act('#upd', () => {
    const body = { status: $('#st', dlg).value, note: $('#nt', dlg).value };
    if (admin) {
      if (rows.some((r) => !r.id)) throw new Error('Pick a department for each row, or remove the empty one.');
      body.departments = rows.map((r) => ({ id: r.id, assigned_to: r.assigned_to }));
    } else if ($('#me', dlg)) body.assigned_to_me = $('#me', dlg).checked;
    return api('/api/complaints/' + c.id, { method: 'PATCH', body });
  });
  act('#edit', () => api('/api/complaints/' + c.id, { method: 'PATCH', body: { description: $('#ed', dlg).value } }));
  act('#arch', () => api(`/api/complaints/${c.id}/archive`, { method: 'POST' }));
  act('#rest', () => api(`/api/complaints/${c.id}/restore`, { method: 'POST' }));
}
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

// ---------- views ----------
// ---------- dashboard charts for admin and maintenance staff (drawn as plain SVG, no chart library) ----------
const monthLabel = (m) => new Date(m + '-01T00:00:00Z').toLocaleString([], { month: 'short', year: '2-digit', timeZone: 'UTC' });

function donutChart(parts, total) {
  if (!total) return '<p class="empty">No complaints yet.</p>';
  let start = 0;
  const arcs = parts.filter((p) => p.value > 0).map((p) => {
    const pct = (p.value / total) * 100;
    const offset = (((25 - start) % 100) + 100) % 100; // 25 = start at the top
    start += pct;
    return `<circle class="${p.cls}" cx="21" cy="21" r="15.9155" fill="none" stroke-width="6" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${offset}"><title>${esc(p.label)}: ${p.value}</title></circle>`;
  }).join('');
  return `<div class="donut-wrap">
    <svg class="donut chart" viewBox="0 0 42 42" role="img" aria-label="Doughnut chart of complaint status: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}">
      <circle class="dn-track" cx="21" cy="21" r="15.9155" fill="none" stroke-width="6"/>${arcs}
      <text class="dn-num" x="21" y="22.5" text-anchor="middle">${total}</text><text class="dn-lbl" x="21" y="27" text-anchor="middle">total</text>
    </svg>
    <ul class="legend">${parts.map((p) => `<li><i class="${p.key}"></i>${esc(p.label)}: <strong>${p.value}</strong> <small>(${Math.round((p.value / total) * 100)}%)</small></li>`).join('')}</ul>
  </div>`;
}

function monthChart(months) {
  if (!months.some((m) => m.reported || m.solved)) return '<p class="empty">No complaints in the last 6 months.</p>';
  const W = 600, H = 250, L = 34, R = 8, T = 18, B = 34;
  const max = Math.max(1, ...months.flatMap((m) => [m.reported, m.solved]));
  const step = Math.ceil(max / 4), top = step * 4;
  const pw = W - L - R, ph = H - T - B, gw = pw / months.length, bw = Math.min(30, gw / 2 - 6);
  const y = (v) => T + ph - (v / top) * ph;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = i * step;
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  months.forEach((m, i) => {
    const cx = L + gw * i + gw / 2;
    const bar = (v, x, cls, name) => `<rect class="${cls}" x="${x}" y="${y(v)}" width="${bw}" height="${T + ph - y(v)}" rx="3"><title>${esc(monthLabel(m.month))}: ${v} ${name}</title></rect>${v ? `<text class="val" x="${x + bw / 2}" y="${y(v) - 4}" text-anchor="middle">${v}</text>` : ''}`;
    g += bar(m.reported, cx - bw - 2, 'bar-rep', 'reported') + bar(m.solved, cx + 2, 'bar-sol', 'solved');
    g += `<text class="axis" x="${cx}" y="${H - 12}" text-anchor="middle">${esc(monthLabel(m.month))}</text>`;
  });
  return `<div class="key"><span><i class="k-rep"></i>Reported</span><span><i class="k-sol"></i>Solved</span></div>
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of complaints reported and solved per month: ${months.map((m) => `${monthLabel(m.month)} ${m.reported} reported, ${m.solved} solved`).join('; ')}">${g}</svg>`;
}

async function staffDashboard(view) {
  const o = await api('/api/overview');
  const t = o.totals;
  const rate = t.total ? Math.round((t.resolved / t.total) * 100) : 0;
  const roleRow = (label, roles) => {
    const rows = o.byRole.filter((r) => roles.includes(r.role));
    return { label, people: rows.reduce((n, r) => n + r.people, 0), complaints: rows.reduce((n, r) => n + r.complaints, 0) };
  };
  const groups = [roleRow('Students', ['student']), roleRow('Faculty', ['faculty']), roleRow('Staff', ['maintenance', 'admin'])];
  const maxPeople = Math.max(1, ...groups.map((g) => g.people));
  const mineDept = me.role === 'maintenance' && me.department_id;
  view.innerHTML = `
    <section class="cards" aria-label="Complaint totals">
      <div class="card"><span>Total complaints</span><strong>${t.total}</strong><small>${t.open + t.in_progress} still being handled</small></div>
      <div class="card"><span>Solved complaints</span><strong>${t.resolved}</strong><small>${rate}% solved${t.avg_days != null ? (t.avg_days < 1 ? ' · usually solved in under a day' : ` · about ${t.avg_days} days to solve`) : ''}</small></div>
      <div class="card"><span>People who complained</span><strong>${t.people}</strong><small>different accounts</small></div>
    </section>
    <div class="two">
      <section class="panel"><h3>Solved and unsolved</h3>${donutChart([
        { label: 'Open', value: t.open, cls: 'dn-open', key: 'k-open' },
        { label: 'In progress', value: t.in_progress, cls: 'dn-prog', key: 'k-prog' },
        { label: 'Solved', value: t.resolved, cls: 'dn-done', key: 'k-done' }], t.total)}</section>
      <section class="panel"><h3>Who complained</h3>
        <div class="bars">${groups.map((g) => `<div class="bar-row"><span>${g.label}</span><div class="bar"><i style="width:${Math.round((g.people / maxPeople) * 100)}%"></i></div><b>${g.people}</b></div>`).join('')}</div>
        <p class="hint">${t.people} ${t.people === 1 ? 'person has' : 'different people have'} filed ${t.total} ${t.total === 1 ? 'complaint' : 'complaints'} in total. ${groups.map((g) => `${g.label}: ${g.complaints}`).join(' · ')}.</p></section>
    </div>
    <section class="panel"><h3>Reported and solved per month</h3>${monthChart(o.months)}</section>
    <section class="panel"><h3>Needs attention${mineDept ? ' in your department' : ''}</h3><div id="recent"></div></section>`;
  bindOpen(view);
  const { complaints } = await api(`/api/complaints?limit=5&status=active${mineDept ? '&department=' + me.department_id : ''}`);
  const box = $('#recent');
  if (box) box.innerHTML = complaintsTable(complaints);
}

async function dashboardView() {
  const h = new Date().getHours();
  const hello = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  const view = shell('dashboard', `${hello}, ${me.first_name}`, 'Keep your school safe and comfortable.');
  if (isStaff()) return staffDashboard(view);
  const s = await api('/api/stats');
  const mine = s.scope === 'mine';
  view.innerHTML = `
    <section class="cards" aria-label="Complaint summary">
      <div class="card"><span>${mine ? 'Your open complaints' : 'Open complaints'}</span><strong>${s.open}</strong></div>
      <div class="card"><span>Resolved this month</span><strong>${s.resolved_month}</strong></div>
      <div class="card"><span>Average days to resolve</span><strong>${s.avg_days ?? '—'}</strong></div>
    </section>
    <section class="panel narrow" id="complaint">
      <h3>Submit facility complaint</h3>
      <form id="cf" novalidate>
        <div class="grid3">
          <div><label for="b">Building</label><select id="b" required><option value="">Select</option>${meta.buildings.map((b) => `<option>${esc(b)}</option>`).join('')}</select></div>
          <div><label for="fl">Floor</label><select id="fl" required><option value="">Select</option>${meta.floors.map((f) => `<option>${esc(f)}</option>`).join('')}</select></div>
          <div><label for="rm">Room</label><select id="rm" required disabled><option value="">Pick a floor first</option></select></div>
        </div>
        <label for="ds">Problem description</label>
        <textarea id="ds" maxlength="2000" placeholder="Describe the issue and where it is located..." required></textarea>
        <label for="ph">Photo of the problem (required)</label>
        <input id="ph" type="file" accept="image/jpeg,image/png,image/webp,image/gif" required>
        <p><button class="btn" type="submit">Submit complaint</button></p>
        <div class="msg" id="msg" role="status" aria-live="polite"></div>
      </form>
    </section>
    <section class="panel"><h3>${mine ? 'Your recent complaints' : 'Needs attention'}</h3><div id="recent"></div></section>`;

  $('#fl').addEventListener('change', () => {
    const i = meta.floors.indexOf($('#fl').value);
    const rm = $('#rm');
    rm.disabled = i < 0;
    rm.innerHTML = i < 0 ? '<option value="">Pick a floor first</option>'
      : '<option value="">Select</option>' + Array.from({ length: 8 }, (_, k) => `<option>${i + 1}0${k + 1}</option>`).join('');
  });
  $('#cf').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#msg');
    if (!$('#ph').files[0]) { $('#ph').focus(); return say(msg, 'Please attach a photo of the problem so staff can see it.'); }
    if (!e.target.reportValidity()) return;
    const fd = new FormData();
    fd.append('building', $('#b').value); fd.append('floor', $('#fl').value); fd.append('room', $('#rm').value);
    fd.append('description', $('#ds').value);
    if ($('#ph').files[0]) fd.append('photo', $('#ph').files[0]);
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const d = await api('/api/complaints', { method: 'POST', body: fd });
      e.target.reset();
      $('#fl').dispatchEvent(new Event('change'));
      say(msg, `Complaint submitted. Your ticket ID is ${d.complaint.ticket_id}. Keep it if you need to follow up.`, true);
      loadRecent();
      const fresh = await api('/api/stats');
      view.querySelector('.cards .card strong').textContent = fresh.open;
    } catch (err) { say(msg, err.message); }
    btn.disabled = false;
  });
  async function loadRecent() {
    const { complaints } = await api(`/api/complaints?limit=5${mine ? '' : '&status=active'}`);
    const box = $('#recent');
    if (box) box.innerHTML = complaintsTable(complaints);
  }
  bindOpen(view);
  loadRecent();
}

async function complaintsView(archived) {
  const title = archived ? 'Archive' : isStaff() ? 'All complaints' : 'My complaints';
  const view = shell(archived ? 'archive' : 'complaints', title,
    archived ? 'Archived complaints are kept for records. You can restore them.' : 'Open a complaint to see its history.');
  let depts = [];
  if (isStaff()) { try { depts = (await api('/api/departments')).departments; } catch { depts = []; } }
  // Maintenance staff start on their own department's complaints.
  const mine = me.role === 'maintenance' && me.department_id && depts.some((d) => d.id === me.department_id) ? String(me.department_id) : '';
  view.innerHTML = `<section class="panel">
    <div class="toolbar">
      <input id="q" type="search" placeholder="Search ticket ID, description, room…" aria-label="Search complaints">
      <select id="stf" aria-label="Filter by status"><option value="">All statuses</option><option>Open</option><option>In Progress</option><option>Resolved</option></select>
      ${isStaff() ? `<select id="dpf" aria-label="Filter by department"><option value="">All departments</option>${depts.map((d) => `<option value="${d.id}" ${String(d.id) === mine ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}<option value="none">Not routed yet</option></select>` : ''}
    </div><div id="list"></div></section>`;
  let timer;
  async function load() {
    const qs = new URLSearchParams({ archived: archived ? '1' : '0', limit: '200', q: $('#q').value, status: $('#stf').value });
    const dp = $('#dpf');
    if (dp && dp.value) qs.set('department', dp.value);
    const { complaints } = await api('/api/complaints?' + qs);
    const box = $('#list');
    if (box) box.innerHTML = complaintsTable(complaints);
  }
  $('#q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
  $('#stf').addEventListener('change', load);
  if ($('#dpf')) $('#dpf').addEventListener('change', load);
  bindOpen(view);
  load();
}

async function usersView() {
  const view = shell('users', 'Users', 'Create staff accounts, change roles, set departments, reset passwords or archive accounts.');
  const { departments: depts } = await api('/api/departments');
  const deptOpts = (sel) => '<option value="">None</option>' + depts.map((d) => `<option value="${d.id}" ${d.id === sel ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  view.innerHTML = `
    <section class="panel"><h3>Add an account</h3>
      <form id="nf" novalidate><div class="grid2">
        <div><label for="a1">First name</label><input id="a1" required></div>
        <div><label for="a2">Last name</label><input id="a2" required></div>
        <div><label for="a3">Email</label><input id="a3" type="email" required></div>
        <div><label for="a4">Role</label><select id="a4"><option value="maintenance">Maintenance staff</option><option value="admin">Administrator</option><option value="faculty">Faculty</option><option value="student">Student</option></select></div>
        <div><label for="a6">Department (maintenance staff only)</label><select id="a6">${deptOpts(null)}</select></div>
        <div><label for="a5">Temporary password</label><input id="a5" type="text" minlength="8" autocomplete="off" required></div>
      </div><p><button class="btn" type="submit">Create account</button></p><div class="msg" id="nm" role="status"></div></form></section>
    <section class="panel"><h3>All accounts</h3><div id="ul"></div></section>`;
  async function load() {
    const { users } = await api('/api/admin/users');
    $('#ul').innerHTML = `<div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Department</th><th>Last login</th><th>Status</th><th>Actions</th></tr></thead><tbody>${users.map((u) => `
      <tr class="${u.archived_at ? 'archived' : ''}"><td>${esc(u.first_name)} ${esc(u.last_name)}</td><td>${esc(u.email)}</td>
      <td>${u.id === me.id ? esc(ROLE_LABEL[u.role]) : `<select data-role="${u.id}" aria-label="Role for ${esc(u.email)}">${Object.keys(ROLE_LABEL).map((r) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('')}</select>`}</td>
      <td>${u.role === 'maintenance' && !u.archived_at ? `<select data-dept="${u.id}" aria-label="Department for ${esc(u.email)}">${deptOpts(u.department_id)}</select>` : esc(u.role === 'maintenance' ? (u.department || '—') : '—')}</td>
      <td>${fmt(u.last_login)}</td><td>${u.archived_at ? 'Archived' : 'Active'}</td>
      <td><button class="btn ghost small" data-pw="${u.id}" data-email="${esc(u.email)}">Reset password</button>
        ${u.id === me.id ? '' : `<button class="btn ghost small" data-arch="${u.id}" data-to="${u.archived_at ? 0 : 1}">${u.archived_at ? 'Restore' : 'Archive'}</button>`}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const patch = async (id, body, okMsg) => { try { await api('/api/admin/users/' + id, { method: 'PATCH', body }); if (okMsg) notify(okMsg); } catch (err) { notify(err.message); } load(); };
  view.addEventListener('change', (e) => {
    const s = e.target.closest('[data-role]'), dp = e.target.closest('[data-dept]');
    if (s) patch(s.dataset.role, { role: s.value });
    if (dp) patch(dp.dataset.dept, { department_id: dp.value || null });
  });
  view.addEventListener('click', (e) => {
    const pw = e.target.closest('[data-pw]'), ar = e.target.closest('[data-arch]');
    if (pw) askPassword(pw.dataset.email).then((v) => { if (v) patch(pw.dataset.pw, { password: v }, 'Password changed for ' + pw.dataset.email + '.'); });
    if (ar) patch(ar.dataset.arch, { archived: ar.dataset.to === '1' });
  });
  $('#nf').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try {
      await api('/api/admin/users', { method: 'POST', body: { first_name: $('#a1').value, last_name: $('#a2').value, email: $('#a3').value, role: $('#a4').value, department_id: $('#a6').value || null, password: $('#a5').value } });
      e.target.reset(); say($('#nm'), 'Account created.', true); load();
    } catch (err) { say($('#nm'), err.message); }
  });
  load();
}

async function departmentsView() {
  const view = shell('departments', 'Departments', 'Repair teams. Route each complaint to the team that should fix it.');
  view.innerHTML = `
    <section class="panel narrow"><h3>Add a department</h3>
      <form id="df" novalidate><div class="grid2">
        <div><label for="dn">Name</label><input id="dn" maxlength="60" placeholder="e.g. Plumbing" required></div>
        <div><label for="dk">Keywords (comma-separated)</label><input id="dk" placeholder="leak, pipe, faucet, toilet"></div>
      </div>
      <p class="hint">Keywords are used to suggest this department when a complaint's description contains them. You always make the final choice.</p>
      <p><button class="btn" type="submit">Add department</button></p><div class="msg" id="dm" role="status"></div></form></section>
    <section class="panel"><h3>All departments</h3><div id="dl"></div></section>`;
  let list = [];
  async function load() {
    list = (await api('/api/departments?all=1')).departments;
    const box = $('#dl');
    if (!box) return;
    box.innerHTML = !list.length ? '<p class="empty">No departments yet.</p>' : `<div class="scroll"><table><thead><tr><th>Department</th><th>Keywords</th><th>Staff</th><th>Open complaints</th><th>Status</th><th></th></tr></thead><tbody>${list.map((d) => `
      <tr class="${d.archived_at ? 'archived' : ''}"><td><strong>${esc(d.name)}</strong></td><td><small>${esc(d.keywords || '—')}</small></td><td>${d.staff}</td><td>${d.open_complaints}</td><td>${d.archived_at ? 'Archived' : 'Active'}</td>
      <td><button class="btn ghost small" data-edit="${d.id}">Edit</button> <button class="btn ghost small" data-darch="${d.id}" data-to="${d.archived_at ? 0 : 1}">${d.archived_at ? 'Restore' : 'Archive'}</button></td></tr>`).join('')}</tbody></table></div>`;
  }
  view.addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-edit]'), ar = e.target.closest('[data-darch]');
    if (ed) editDepartment(list.find((d) => String(d.id) === ed.dataset.edit), load);
    if (ar) {
      try { await api('/api/admin/departments/' + ar.dataset.darch, { method: 'PATCH', body: { archived: ar.dataset.to === '1' } }); } catch (err) { notify(err.message); }
      load();
    }
  });
  $('#df').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!e.target.reportValidity()) return;
    try {
      await api('/api/admin/departments', { method: 'POST', body: { name: $('#dn').value, keywords: $('#dk').value } });
      e.target.reset(); say($('#dm'), 'Department added.', true); load();
    } catch (err) { say($('#dm'), err.message); }
  });
  load();
}

function editDepartment(d, reload) {
  dlg.innerHTML = `<div class="dlg-in"><form id="ef" novalidate><h3>Edit department</h3>
    <label for="en">Name</label><input id="en" maxlength="60" value="${esc(d.name)}" required>
    <label for="ek">Keywords (comma-separated)</label><textarea id="ek" maxlength="1500">${esc(d.keywords)}</textarea>
    <p class="row"><button class="btn" type="submit">Save</button><button class="btn ghost" type="button" id="ec">Cancel</button></p>
    <div class="msg" id="em" role="status"></div></form></div>`;
  dlg.showModal();
  $('#ec', dlg).addEventListener('click', () => dlg.close());
  $('#ef', dlg).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/admin/departments/' + d.id, { method: 'PATCH', body: { name: $('#en', dlg).value, keywords: $('#ek', dlg).value } });
      dlg.close(); reload();
    } catch (err) { say($('#em', dlg), err.message); }
  });
}

async function logsView() {
  const view = shell('logs', 'Login logs', 'Every sign-in attempt, newest first.');
  const { logs } = await api('/api/admin/login-logs?limit=200');
  view.innerHTML = `<section class="panel">${!logs.length ? '<p class="empty">No logins yet.</p>' : `<div class="scroll"><table><thead><tr><th>Time</th><th>Email</th><th>Person</th><th>Role</th><th>Result</th><th>IP address</th></tr></thead><tbody>${logs.map((l) => `
    <tr><td>${fmt(l.logged_in_at)}</td><td>${esc(l.email)}</td><td>${esc(l.name || '—')}</td><td>${esc(l.role ? ROLE_LABEL[l.role] : '—')}</td>
    <td><span class="badge ${l.success ? 's-resolved' : 's-fail'}">${l.success ? 'Success' : 'Failed'}</span>${l.success ? '' : ' <small>' + esc(l.reason) + '</small>'}</td><td>${esc(l.ip)}</td></tr>`).join('')}</tbody></table></div>`}</section>`;
}

async function reportsView() {
  const view = shell('reports', 'Reports', 'Complaint totals across the campus.');
  const r = await api('/api/admin/reports');
  const t = r.totals;
  const max = (arr, k) => Math.max(1, ...arr.map((x) => x[k] || 0));
  const bars = (arr, label, k, cls = '') => `<div class="bars">${arr.map((x) => `<div class="bar-row"><span>${esc(x[label])}</span><div class="bar"><i class="${cls}" style="width:${Math.round(((x[k] || 0) / max(arr, k)) * 100)}%"></i></div><b>${x[k] || 0}</b></div>`).join('')}</div>`;
  view.innerHTML = `
    <section class="cards">
      <div class="card"><span>Total complaints</span><strong>${t.total}</strong></div>
      <div class="card"><span>Still open or in progress</span><strong>${t.open + t.in_progress}</strong></div>
      <div class="card"><span>Average days to resolve</span><strong>${t.avg_days ?? '—'}</strong></div>
    </section>
    <div class="panel"><div class="toolbar"><a class="btn small" href="/api/admin/export.csv" download>Download complaints (CSV)</a><button class="btn ghost small" id="pr">Print</button></div></div>
    <div class="two">
      <section class="panel"><h3>Complaints by building</h3>${bars(r.byBuilding, 'building', 'total')}
        <p class="hint">Unresolved: ${r.byBuilding.map((b) => `${esc(b.building)} ${b.unresolved}`).join(' · ')}</p></section>
      <section class="panel"><h3>Complaints by department</h3>${bars(r.byDepartment, 'department', 'total', 'b2')}
        <p class="hint">A complaint sent to several departments is counted in each one. Not routed yet: ${r.notRouted} · Unresolved: ${r.byDepartment.filter((x) => x.total).map((x) => `${esc(x.department)} ${x.unresolved}`).join(' · ') || '—'}</p></section>
      <section class="panel"><h3>Reported per month</h3>${r.byMonth.length ? bars(r.byMonth, 'month', 'reported') : '<p class="empty">No data yet.</p>'}</section>
      <section class="panel"><h3>Most reported rooms</h3>${r.hotspots.length ? `<table><tbody>${r.hotspots.map((h) => `<tr><td>${esc(h.building)} · ${esc(h.floor)} · ${esc(h.room)}</td><td><b>${h.total}</b></td></tr>`).join('')}</tbody></table>` : '<p class="empty">No data yet.</p>'}</section>
      <section class="panel"><h3>Active accounts</h3><table><tbody>${r.users.map((u) => `<tr><td>${esc(ROLE_LABEL[u.role])}</td><td><b>${u.total}</b></td></tr>`).join('')}</tbody></table></section>
    </div>`;
  $('#pr').addEventListener('click', () => window.print());
}

function helpView() {
  const view = shell('help', 'Help Center', 'Quick answers.');
  view.innerHTML = `<section class="panel narrow help"><dl>
    <dt>How do I report a problem?</dt><dd>Go to the Dashboard, choose the building, floor and room, describe the problem and attach a photo. The photo is required so staff can see the specific problem.</dd>
    <dt>What do the statuses mean?</dt><dd>Open: waiting for maintenance. In Progress: someone is working on it. Resolved: the work is done.</dd>
    <dt>Can I change a complaint?</dt><dd>You can edit the description while it is Open. Once it is resolved you can archive it.</dd>
    <dt>Why is there no delete button?</dt><dd>Complaints are archived instead of deleted so the school keeps a record. Archived items can be restored.</dd>
    <dt>How will I know when my problem is being fixed?</dt><dd>The bell at the top shows a number when staff change the status of a complaint you filed (in progress, resolved). Click a message to open that complaint, or choose Mark all as read.</dd>
    <dt>Who fixes my problem?</dt><dd>The administrator sends each complaint to the right team (for example Plumbing for a leak, IT for the internet), and to up to three teams when a problem needs more than one, then to a person on each team. You can see the teams on your complaint.</dd>
    <dt>I forgot my password.</dt><dd>Ask the school administrator to reset it for you.</dd></dl></section>`;
}

// ---------- router ----------
// The browser shares ONE login between all tabs. If another tab logs in as someone else,
// this tab must notice and switch, otherwise its screens would not match who the server sees.
async function syncSession() {
  if (!me) return false;
  try {
    const { user } = await api('/api/me');
    if (user.id === me.id && user.role === me.role) return false;
    me = user;
    meta = await api('/api/meta');
  } catch (err) {
    if (err.status !== 401) return false;
    me = null;
    notice = 'Your session ended. Log in again.';
  }
  location.hash = me ? '#/dashboard' : '#/login';
  await route();
  return true;
}
window.addEventListener('focus', syncSession);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncSession(); });

// Page loads run one at a time, and a load that was replaced by a newer one is skipped.
// (Logging in triggers two route() calls at once; running them together made them overwrite each other.)
let routeSeq = 0;
let routeQueue = Promise.resolve();
function route() {
  const seq = ++routeSeq;
  routeQueue = routeQueue.then(() => (seq === routeSeq ? doRoute() : null));
  return routeQueue;
}

async function doRoute() {
  if (dlg.open) dlg.close();
  const name = location.hash.replace(/^#\/?/, '') || (me ? 'dashboard' : 'login');
  if (!me) return name === 'signup' ? signupView() : loginView();
  const adminOnly = ['users', 'departments', 'logs', 'reports'];
  try {
    if (adminOnly.includes(name) && me.role !== 'admin') return (location.hash = '#/dashboard');
    if (name === 'complaints') return await complaintsView(false);
    if (name === 'archive') return await complaintsView(true);
    if (name === 'users') return await usersView();
    if (name === 'departments') return await departmentsView();
    if (name === 'logs') return await logsView();
    if (name === 'reports') return await reportsView();
    if (name === 'help') return helpView();
    if (name === 'login' || name === 'signup') return (location.hash = '#/dashboard');
    return await dashboardView();
  } catch (err) {
    if (err.status === 401) { me = null; notice = 'Your session ended. Log in again.'; return loginView(); }
    notify(err.message);
  }
}
window.addEventListener('hashchange', route);

(async function start() {
  try {
    me = (await api('/api/me')).user;
    meta = await api('/api/meta');
  } catch { me = null; }
  route();
})();
