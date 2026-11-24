# Liceo MaintainIT

One website that combines your three pages (login, sign-up, dashboard) and stores everything in a real database (SQLite).

## Run it

1. Install Node.js 22.13 or newer (the current LTS is fine) from nodejs.org. No C++ build tools are needed
2. In this folder run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000

The first time it starts, it prints the **administrator email and password** in the terminal. Log in with "Staff" selected, then use Users > Reset password to change it.
To choose your own: `ADMIN_PASSWORD=YourPassword123 npm start` (Windows PowerShell: `$env:ADMIN_PASSWORD="YourPassword123"; npm start`).

Put your logo at `public/ldcu.jpg.png`. If the file is missing, a letter "L" shows instead.

## Who can do what

| Role | Can do |
|---|---|
| Student / Faculty | Sign up, log in, submit complaints with a photo, follow their own complaints, edit the description while Open, archive their resolved complaints |
| Maintenance staff | See complaints (they start on their own department's list), change status, assign to themselves, add notes, archive resolved ones |
| Administrator | Everything above, plus routing complaints to departments, Departments, Users (create staff, set their department, change roles, reset passwords, archive accounts), Login logs, Reports, CSV export |

Maintenance and admin accounts are created by the administrator (Users page). Sign-up is only for students and faculty, and only with an `@liceo.edu.ph` email (change with `EMAIL_DOMAIN=...`).

## Departments (repair teams)

The admin sends each complaint to the team that should fix it, then picks a person on that team:
1. Open a complaint, choose a **Department** (for example Plumbing for a leak, IT / Network for the internet), then choose **Assigned to**. The staff list only shows people in that department.
2. The page suggests a department from the description using each department's keywords. Press **Use it** or pick another one.
3. Set each maintenance worker's department on the **Users** page. Add, rename, edit keywords or archive departments on the **Departments** page.

Starting departments: Plumbing, IT / Network, Electrical, Carpentry, Air Conditioning, Janitorial & General.
Upgrading an older copy: just replace the files and run `npm start`. Your existing database is upgraded automatically and nothing is lost.

## Database (`data/maintainit.db`, defined in `schema.sql`)

| Table | Purpose |
|---|---|
| `roles` | admin, student, faculty, maintenance |
| `users` | unique id, unique email, name, phone, gender, role, department (maintenance staff), hashed password, `archived_at` |
| `sessions` | who is logged in right now (8 hours) |
| `login_logs` | every login attempt: who, when, success or failure, reason, IP |
| `departments` | repair teams (name, keywords used for suggestions, `archived_at`) |
| `buildings` | SAC, NAC, WAC, EAC |
| `complaints` | reporter, building, floor, room, description, photo, status, department, assigned staff, `archived_at` |
| `complaint_updates` | history of each status change, assignment and note |

Nothing is deleted. Users, complaints, history and login logs are archived or kept, and the database itself refuses `DELETE` on them. To look inside, open the `.db` file with DB Browser for SQLite (sqlitebrowser.org).

## Security notes

- Passwords are hashed with bcrypt. Five wrong passwords lock that email for 15 minutes.
- Photos must be JPG, PNG, WebP or GIF under 5 MB, and only the reporter and staff can view them.
- Before putting it online, serve it over HTTPS and start it with `COOKIE_SECURE=1`.
- You may see "ExperimentalWarning: SQLite" when starting. It is harmless: the database is built into Node.
- Back up `data/` and `uploads/` regularly.

## Differences from the original pages

- Log in has a third choice, **Staff**, for maintenance and admin accounts.
- Sign-up roles are Student and Faculty (your sign-up page said "Teacher", which is stored as Faculty).
- Room choices now depend on the floor (2nd floor shows 201 to 208).
- The dashboard numbers come from the database instead of fixed values.
- Forgot password: the administrator resets it (no email service is connected).
"# MaintainIT-LDCU2026-2027" 
"# MaintainIT-LDCU2026-2027" 
"# maintainit" 
"# maintainit" 
"# maintainit" 
"# maintainit" 
"# maintainit" 
"# maintainit" 
