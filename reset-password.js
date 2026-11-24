// Usage: node reset-password.js email@liceo.edu.ph NewPassword123
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.log('Usage: node reset-password.js email@liceo.edu.ph NewPassword (at least 8 characters)');
  process.exit(1);
}
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data', 'maintainit.db'));
const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
if (!user) { console.log('No account found for', email); process.exit(1); }
db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
  .run(bcrypt.hashSync(password, 10), new Date().toISOString(), user.id);
db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
console.log('Password changed for', email);
