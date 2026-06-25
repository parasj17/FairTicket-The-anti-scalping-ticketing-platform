##  Aryan Gurav — Anti-Scalping Features & Admin Panel

**Files:** `server.js` (partial), `frontend/app.js` (partial)

### Responsibilities:
- Built the **virtual queue system** — `/api/queue/join`, `/api/my-queues`, `/api/queue/:id/position`
- Implemented the **resale marketplace** — `/api/resale` (list & browse), `/api/resale/:id/buy` with ownership transfer
- Added the **MySQL `prevent_scalping` trigger** (in `schema.sql`) — blocks resale listings above original price at the database level
- Built the **ticket entry scanner** — `/api/scan` with duplicate-scan rejection via `ticket_scan_logs`
- Implemented the **Admin Analytics dashboard** — `/api/analytics` (revenue, queue sizes, tickets sold, resale stats)
- Built **Admin Event Management** — `/api/admin/events` (create, list, delete) with auto seat generation
- Implemented **suspicious login detection** — `/api/admin/suspicious-logins` flags IPs with >10 failed attempts/hour
- Wired up the **admin frontend pages** — Analytics charts, event creation form, entry scan UI
