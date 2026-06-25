## Paras Jadhav — Database Design & Core Backend

**Files:** `schema.sql` (partial), `seed.sql`, `server.js` (partial), `.env.example`, `frontend/style.css`,

### Responsibilities:
- Designed the full **MySQL database schema** — `users`, `events`, `seats`, `tickets`, `seat_locks`, `login_attempts`, `ticket_scan_logs`, `resale_market`, `ticket_queue` tables
- Wrote the **seed data** (`seed.sql`) — sample events, seats, and test accounts
- Implemented **user authentication** — `/api/register` and `/api/login` with JWT token issuance
- Built the **atomic seat booking** system (`/api/book`) using SQL transactions and `FOR UPDATE` row-level locking to prevent double-booking race conditions
- Set up **Express server** boilerplate — database connection pool, CORS, middleware, rate limiting (global + booking-specific)
- Configured **JWT authentication middleware** and **admin-only middleware**

