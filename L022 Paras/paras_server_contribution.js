/**
 * FairTicket – server.js
 * Contribution: Paras Jadhav
 *
 * Covers:
 *   - Server setup & configuration (Express, CORS, dotenv)
 *   - MySQL connection pool
 *   - Rate limiting middleware (global + booking-specific)
 *   - JWT authentication middleware
 *   - Admin-only middleware
 *   - Login attempt logging helper
 *   - DB connection verification on startup
 *   - POST /api/register
 *   - POST /api/login
 *   - GET  /api/events
 *   - GET  /api/events/:event_id/seats
 *   - POST /api/book  (atomic transaction + FOR UPDATE row-level locking)
 *   - GET  /api/my-tickets
 *   - Server startup
 */

const express   = require("express");
const mysql     = require("mysql2/promise");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const cors      = require("cors");
const path      = require("path");
require("dotenv").config();

const app = express();

// ─────────────────────────────────────────────────────────────
// DATABASE POOL
// ─────────────────────────────────────────────────────────────
const pool = mysql.createPool({
  host:               process.env.DB_HOST     || "localhost",
  port:               process.env.DB_PORT     || 3306,
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME     || "fairticket",
  waitForConnections: true,
  connectionLimit:    10,
  timezone:           "Z",   // store/return all datetimes as UTC
});

// Serve the frontend as static files
app.use(express.static(path.join(__dirname, "frontend")));

// ─────────────────────────────────────────────────────────────
// CORS — Restrict to known local frontend origins
// ─────────────────────────────────────────────────────────────
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:8080",
  "null",   // file:// origin when opening index.html directly
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
}));
app.use(express.json());

// ─────────────────────────────────────────────────────────────
// RATE LIMITERS
// ─────────────────────────────────────────────────────────────

// Global: 100 requests per 15 minutes per IP
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests, please slow down." },
});
app.use(limiter);

// Booking-only: 5 requests per minute per IP (anti-bot)
const bookingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Booking rate limit exceeded. Suspicious activity flagged." },
});

// ─────────────────────────────────────────────────────────────
// AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────

// Standard JWT verification — used on all protected routes
function authenticate(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// Admin-only: rejects non-admin users at middleware level
function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    if (!req.user.is_admin) return res.status(403).json({ error: "Admin access required" });
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─────────────────────────────────────────────────────────────
// LOGIN ATTEMPT LOGGER
// Records every login (success or failure) for suspicious IP detection
// ─────────────────────────────────────────────────────────────
async function logLoginAttempt(user_id, ip_address, success) {
  try {
    await pool.execute(
      "INSERT INTO login_attempts (user_id, ip_address, success) VALUES (?, ?, ?)",
      [user_id, ip_address, success]
    );
  } catch (err) {
    console.error("Failed to log login attempt:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// DB VERIFICATION ON STARTUP
// ─────────────────────────────────────────────────────────────
async function verifyDB() {
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
  console.log("✓ MySQL connection verified");
}

// ─────────────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────────────

// POST /api/register
// 1NF: name split into first_name + last_name (atomic attributes)
app.post("/api/register", async (req, res) => {
  const { first_name, last_name, email, phone, password } = req.body;
  if (!first_name || !last_name || !email || !password)
    return res.status(400).json({ error: "First name, last name, email, and password are required" });

  try {
    const password_hash = await bcrypt.hash(password, 12);
    const user_id = crypto.randomUUID();

    await pool.execute(
      "INSERT INTO users (user_id, first_name, last_name, email, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)",
      [user_id, first_name, last_name, email, phone || null, password_hash]
    );

    const [[user]] = await pool.execute(
      "SELECT user_id, first_name, last_name, email, phone, is_admin, created_at FROM users WHERE user_id = ?",
      [user_id]
    );
    user.name = `${user.first_name} ${user.last_name}`;  // backward-compat alias

    const token = jwt.sign(
      { user_id: user.user_id, email: user.email, is_admin: !!user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.status(201).json({ user, token });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email already registered" });
    console.error("Registration error:", err.message);
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password required" });

  const ip = req.ip;

  try {
    const [[user]] = await pool.execute("SELECT * FROM users WHERE email = ?", [email]);

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      await logLoginAttempt(user?.user_id ?? null, ip, false);
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await logLoginAttempt(user.user_id, ip, true);
    const token = jwt.sign(
      { user_id: user.user_id, email: user.email, is_admin: !!user.is_admin },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.json({
      token,
      user: {
        user_id:    user.user_id,
        first_name: user.first_name,
        last_name:  user.last_name,
        name:       `${user.first_name} ${user.last_name}`,  // backward-compat alias
        email:      user.email,
        is_admin:   !!user.is_admin,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// ─────────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────────

// GET /api/events
// 3NF: events_view provides computed available_seats; 1NF venue alias included
app.get("/api/events", async (req, res) => {
  try {
    const [events] = await pool.execute("SELECT * FROM events_view ORDER BY event_date ASC");
    res.json(events);
  } catch (err) {
    console.error("Events fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// GET /api/events/:event_id/seats — returns all seats with live lock status
app.get("/api/events/:event_id/seats", authenticate, async (req, res) => {
  const { event_id } = req.params;
  try {
    const [seats] = await pool.execute(
      `SELECT s.seat_id, s.section, s.row_label AS \`row\`, s.seat_number, s.status,
         CASE WHEN sl.seat_id IS NOT NULL AND sl.expires_at > NOW() THEN TRUE ELSE FALSE END AS is_locked
       FROM seats s
       LEFT JOIN seat_locks sl ON s.seat_id = sl.seat_id
       WHERE s.event_id = ?
       ORDER BY s.section, s.row_label, s.seat_number`,
      [event_id]
    );
    res.json(seats);
  } catch (err) {
    console.error("Seats fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch seats" });
  }
});

// ─────────────────────────────────────────────────────────────
// BOOKING — atomic transaction with row-level locking
// ─────────────────────────────────────────────────────────────

// POST /api/book — accepts seat_ids (array) + event_id
// Uses BEGIN TRANSACTION + FOR UPDATE to prevent concurrent double-booking
app.post("/api/book", authenticate, bookingLimiter, async (req, res) => {
  const { seat_ids, event_id } = req.body;
  const user_id = req.user.user_id;

  if (!Array.isArray(seat_ids) || seat_ids.length === 0)
    return res.status(400).json({ error: "seat_ids array is required" });
  if (seat_ids.length > 4)
    return res.status(400).json({ error: "Maximum 4 seats per booking" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Enforce max 4 tickets per user per event BEFORE booking
    // 3NF: tickets has no event_id column → join through seats to filter by event
    const [[{ ticketCount }]] = await conn.execute(
      `SELECT COUNT(*) AS ticketCount
       FROM tickets t
       JOIN seats s ON t.seat_id = s.seat_id
       WHERE t.owner_user_id = ? AND s.event_id = ?
         AND t.ticket_status IN ('PURCHASED','RESALE_LISTED')`,
      [user_id, event_id]
    );
    if (ticketCount + seat_ids.length > 4) {
      await conn.rollback();
      return res.status(409).json({
        error: `You already have ${ticketCount} ticket(s) for this event. Maximum is 4.`,
      });
    }

    const bookedTickets = [];

    for (const seat_id of seat_ids) {
      // Row-level lock per seat — prevents concurrent double-booking
      const [[seat]] = await conn.execute(
        "SELECT * FROM seats WHERE seat_id = ? FOR UPDATE",
        [seat_id]
      );

      if (!seat || seat.status !== "AVAILABLE") {
        await conn.rollback();
        return res.status(409).json({ error: `Seat ${seat_id} is no longer available` });
      }

      const ticket_id = crypto.randomUUID();

      await conn.execute(
        // 3NF: event_id removed from tickets (derived via seat_id → seats.event_id)
        "INSERT INTO tickets (ticket_id, seat_id, owner_user_id, ticket_status) VALUES (?, ?, ?, 'PURCHASED')",
        [ticket_id, seat_id, user_id]
      );

      await conn.execute(
        "UPDATE seats SET status = 'PURCHASED' WHERE seat_id = ?",
        [seat_id]
      );

      // 3NF: available_seats removed from events table — computed live in events_view

      // 5-minute seat lock grace period after purchase
      const lock_id = crypto.randomUUID();
      await conn.execute(
        `INSERT INTO seat_locks (lock_id, seat_id, user_id, expires_at)
         VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 5 MINUTE))
         ON DUPLICATE KEY UPDATE
           user_id    = ?,
           expires_at = DATE_ADD(NOW(), INTERVAL 5 MINUTE)`,
        [lock_id, seat_id, user_id, user_id]
      );

      bookedTickets.push(ticket_id);
    }

    await conn.commit();

    const placeholders = bookedTickets.map(() => "?").join(",");
    const [tickets] = await conn.execute(
      `SELECT * FROM tickets WHERE ticket_id IN (${placeholders})`,
      bookedTickets
    );

    res.status(201).json({ success: true, tickets });
  } catch (err) {
    await conn.rollback();
    console.error("Booking error:", err.message);
    res.status(500).json({ error: "Booking failed: " + err.message });
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────
// MY TICKETS
// ─────────────────────────────────────────────────────────────

// GET /api/my-tickets
app.get("/api/my-tickets", authenticate, async (req, res) => {
  const user_id = req.user.user_id;
  try {
    const [rows] = await pool.execute(
      // 3NF: tickets has no event_id → route via seats; events_view gives venue alias
      `SELECT t.ticket_id, t.ticket_status, t.purchase_time,
              e.event_id, e.event_name, e.venue, e.event_date, e.ticket_price,
              s.section, s.row_label AS \`row\`, s.seat_number
       FROM tickets      t
       JOIN seats        s ON t.seat_id   = s.seat_id
       JOIN events_view  e ON s.event_id  = e.event_id
       WHERE t.owner_user_id = ?
       ORDER BY t.purchase_time DESC`,
      [user_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("My tickets error:", err.message);
    res.status(500).json({ error: "Failed to fetch tickets" });
  }
});

// ─────────────────────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;

verifyDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✓ FairTicket API running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("MySQL connection failed:", err.message);
    process.exit(1);
  });
