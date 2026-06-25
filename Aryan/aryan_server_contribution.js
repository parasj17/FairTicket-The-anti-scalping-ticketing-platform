/**
 * FairTicket – server.js
 * Contribution: Aryan Gurav
 *
 * Covers:
 *   - POST /api/queue/join          — join the virtual queue for an event
 *   - GET  /api/queue/:id/position  — check your position in the queue
 *   - GET  /api/my-queues           — view all active queues for the user
 *   - GET  /api/resale              — browse active resale listings
 *   - POST /api/resale              — list a purchased ticket for resale (price-capped)
 *   - POST /api/resale/:id/buy      — buy a resale ticket (atomic ownership transfer)
 *   - POST /api/scan                — scan a ticket for entry (duplicate scan rejection)
 *   - GET  /api/analytics           — platform-wide analytics (admin only)
 *   - GET  /api/admin/events        — list all events (admin)
 *   - POST /api/admin/events        — create event + auto-generate seats (admin)
 *   - DELETE /api/admin/events/:id  — delete event and all related data (admin)
 *   - GET  /api/admin/suspicious-logins — flag IPs with >10 failed login attempts/hour
 */

// ─────────────────────────────────────────────────────────────
// VIRTUAL QUEUE SYSTEM
// Users join a numbered queue per event; position is tracked in the DB
// ─────────────────────────────────────────────────────────────

// POST /api/queue/join
app.post("/api/queue/join", authenticate, async (req, res) => {
  const { event_id } = req.body;
  const user_id = req.user.user_id;

  try {
    // Prevent duplicate queue entries per user per event
    const [[existing]] = await pool.execute(
      "SELECT * FROM ticket_queue WHERE user_id = ? AND event_id = ?",
      [user_id, event_id]
    );
    if (existing)
      return res.json({ message: "Already in queue", position: existing.queue_position });

    // Assign next sequential position
    const [[{ next_pos }]] = await pool.execute(
      "SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_pos FROM ticket_queue WHERE event_id = ?",
      [event_id]
    );

    const queue_id = crypto.randomUUID();
    await pool.execute(
      "INSERT INTO ticket_queue (queue_id, event_id, user_id, queue_position) VALUES (?, ?, ?, ?)",
      [queue_id, event_id, user_id, next_pos]
    );

    const [[queue_entry]] = await pool.execute(
      "SELECT * FROM ticket_queue WHERE queue_id = ?",
      [queue_id]
    );
    res.status(201).json({ position: next_pos, queue_entry });
  } catch (err) {
    console.error("Queue join error:", err.message);
    res.status(500).json({ error: "Failed to join queue" });
  }
});

// GET /api/queue/:event_id/position
app.get("/api/queue/:event_id/position", authenticate, async (req, res) => {
  const { event_id } = req.params;
  const user_id = req.user.user_id;

  try {
    const [[row]] = await pool.execute(
      "SELECT queue_position FROM ticket_queue WHERE event_id = ? AND user_id = ?",
      [event_id, user_id]
    );
    if (!row) return res.status(404).json({ error: "Not in queue" });
    res.json({ position: row.queue_position });
  } catch (err) {
    console.error("Queue position error:", err.message);
    res.status(500).json({ error: "Failed to fetch queue position" });
  }
});

// GET /api/my-queues — returns all WAITING queue entries for the logged-in user
app.get("/api/my-queues", authenticate, async (req, res) => {
  const user_id = req.user.user_id;
  try {
    const [rows] = await pool.execute(
      // 3NF: events_view computes available_seats live; 1NF: venue alias provided by view
      `SELECT q.queue_id, q.queue_position, q.entry_time, q.status,
              e.event_id, e.event_name, e.venue, e.event_date,
              e.available_seats, e.total_seats, e.ticket_price
       FROM ticket_queue q
       JOIN events_view e ON q.event_id = e.event_id
       WHERE q.user_id = ? AND q.status = 'WAITING'
       ORDER BY q.entry_time ASC`,
      [user_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("My queues error:", err.message);
    res.status(500).json({ error: "Failed to fetch queue positions" });
  }
});

// ─────────────────────────────────────────────────────────────
// RESALE MARKETPLACE
// Price enforced by MySQL BEFORE INSERT trigger `prevent_scalping`
// and a server-side guard — sellers cannot list above original price
// ─────────────────────────────────────────────────────────────

// GET /api/resale — public listing of all active resale tickets
app.get("/api/resale", async (req, res) => {
  try {
    const [rows] = await pool.execute(
      // 3NF: tickets has no event_id → join via seats
      // 1NF: seller name from first_name + last_name (no longer a single name column)
      `SELECT rm.*, s.event_id, e.event_name, e.ticket_price AS original_price,
         CONCAT(u.first_name, ' ', u.last_name) AS seller_name
       FROM resale_market rm
       JOIN tickets t ON rm.ticket_id = t.ticket_id
       JOIN seats   s ON t.seat_id    = s.seat_id
       JOIN events  e ON s.event_id   = e.event_id
       JOIN users   u ON rm.seller_id = u.user_id
       WHERE rm.status = 'ACTIVE'
       ORDER BY rm.listed_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("Resale fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch resale listings" });
  }
});

// POST /api/resale — list a purchased ticket for resale
// DB trigger `prevent_scalping` fires on INSERT — rejects price > original
app.post("/api/resale", authenticate, async (req, res) => {
  const { ticket_id, price } = req.body;
  const seller_id = req.user.user_id;

  if (!ticket_id || price == null || isNaN(Number(price)) || Number(price) <= 0)
    return res.status(400).json({ error: "ticket_id and a positive price are required" });

  try {
    // 3NF: tickets has no event_id → join through seats to reach events
    const [[ownership]] = await pool.execute(
      `SELECT t.*, e.ticket_price AS original_price
       FROM tickets t
       JOIN seats  s ON t.seat_id   = s.seat_id
       JOIN events e ON s.event_id  = e.event_id
       WHERE t.ticket_id = ? AND t.owner_user_id = ?`,
      [ticket_id, seller_id]
    );
    if (!ownership)
      return res.status(403).json({ error: "You don't own this ticket" });
    if (ownership.ticket_status !== "PURCHASED")
      return res.status(409).json({ error: `Ticket cannot be listed — current status: ${ownership.ticket_status}` });

    // Prevent duplicate active listings for the same ticket
    const [[dupListing]] = await pool.execute(
      "SELECT listing_id FROM resale_market WHERE ticket_id = ? AND status = 'ACTIVE'",
      [ticket_id]
    );
    if (dupListing)
      return res.status(409).json({ error: "Ticket is already listed on the resale market" });

    // Server-side price cap (DB trigger is the authoritative enforcement)
    if (Number(price) > Number(ownership.original_price))
      return res.status(400).json({
        error: `Resale price (₹${price}) cannot exceed original price (₹${ownership.original_price})`,
      });

    const listing_id = crypto.randomUUID();
    await pool.execute(
      "INSERT INTO resale_market (listing_id, ticket_id, seller_id, price) VALUES (?, ?, ?, ?)",
      [listing_id, ticket_id, seller_id, Number(price)]
    );

    await pool.execute(
      "UPDATE tickets SET ticket_status = 'RESALE_LISTED' WHERE ticket_id = ?",
      [ticket_id]
    );

    const [[listing]] = await pool.execute(
      "SELECT * FROM resale_market WHERE listing_id = ?",
      [listing_id]
    );
    res.status(201).json({ success: true, listing });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/resale/:listing_id/buy — atomic ticket ownership transfer
app.post("/api/resale/:listing_id/buy", authenticate, async (req, res) => {
  const { listing_id } = req.params;
  const buyer_id = req.user.user_id;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    const [[listing]] = await conn.execute(
      "SELECT * FROM resale_market WHERE listing_id = ? AND status = 'ACTIVE' FOR UPDATE",
      [listing_id]
    );

    if (!listing) {
      await conn.rollback();
      return res.status(404).json({ error: "Listing not found or already sold" });
    }

    // Prevent seller from buying their own listing
    if (listing.seller_id === buyer_id) {
      await conn.rollback();
      return res.status(409).json({ error: "You cannot buy your own resale listing" });
    }

    // Transfer ticket ownership atomically
    await conn.execute(
      "UPDATE tickets SET owner_user_id = ?, ticket_status = 'PURCHASED' WHERE ticket_id = ?",
      [buyer_id, listing.ticket_id]
    );

    await conn.execute(
      "UPDATE resale_market SET status = 'SOLD' WHERE listing_id = ?",
      [listing_id]
    );

    await conn.commit();
    res.json({ success: true, message: "Ticket transferred successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("Resale buy error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────
// TICKET SCANNING — Entry Gate
// Duplicate scans are rejected via ticket_scan_logs table
// ─────────────────────────────────────────────────────────────

// POST /api/scan
app.post("/api/scan", authenticate, async (req, res) => {
  const { ticket_id } = req.body;
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    // Reject duplicate scans immediately
    const [[alreadyScanned]] = await conn.execute(
      "SELECT log_id FROM ticket_scan_logs WHERE ticket_id = ?",
      [ticket_id]
    );
    if (alreadyScanned) {
      await conn.rollback();
      return res.status(409).json({ error: "Duplicate entry: Ticket already scanned" });
    }

    // Validate ticket status
    const [[ticket]] = await conn.execute(
      "SELECT * FROM tickets WHERE ticket_id = ? FOR UPDATE",
      [ticket_id]
    );

    if (!ticket || ticket.ticket_status !== "PURCHASED") {
      await conn.rollback();
      return res.status(400).json({
        error: `Invalid ticket status: ${ticket?.ticket_status ?? "not found"}`,
      });
    }

    // Log the scan and mark ticket as USED
    const log_id = crypto.randomUUID();
    await conn.execute(
      "INSERT INTO ticket_scan_logs (log_id, ticket_id) VALUES (?, ?)",
      [log_id, ticket_id]
    );
    await conn.execute(
      "UPDATE tickets SET ticket_status = 'USED' WHERE ticket_id = ?",
      [ticket_id]
    );

    await conn.commit();
    res.json({ success: true, message: "Entry granted", ticket });
  } catch (err) {
    await conn.rollback();
    console.error("Scan error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ─────────────────────────────────────────────────────────────
// ANALYTICS (admin only)
// ─────────────────────────────────────────────────────────────

// GET /api/analytics
app.get("/api/analytics", authenticateAdmin, async (req, res) => {
  try {
    const [
      [ticketsSold],
      [resaleStats],
      [queueSizes],
      [[revenue]],
    ] = await Promise.all([
      // 3NF: join through seats for event_id (removed from tickets)
      pool.execute(`
        SELECT e.event_name, COUNT(t.ticket_id) AS tickets_sold
        FROM tickets t
        JOIN seats  s ON t.seat_id   = s.seat_id
        JOIN events e ON s.event_id  = e.event_id
        WHERE t.ticket_status != 'RESALE_LISTED'
        GROUP BY e.event_name
      `),
      pool.execute(`
        SELECT
          SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_listings,
          SUM(CASE WHEN status = 'SOLD'   THEN 1 ELSE 0 END) AS sold_listings,
          AVG(price)                                          AS avg_resale_price
        FROM resale_market
      `),
      pool.execute(`
        SELECT event_id, COUNT(*) AS queue_size
        FROM ticket_queue
        WHERE status = 'WAITING'
        GROUP BY event_id
      `),
      // 3NF: join through seats for event_id (removed from tickets)
      pool.execute(`
        SELECT SUM(e.ticket_price) AS total_revenue
        FROM tickets t
        JOIN seats  s ON t.seat_id   = s.seat_id
        JOIN events e ON s.event_id  = e.event_id
        WHERE t.ticket_status IN ('PURCHASED', 'USED')
      `),
    ]);

    res.json({
      tickets_sold: ticketsSold,
      resale: resaleStats[0] ?? {},
      queue_sizes: queueSizes,
      total_revenue: revenue?.total_revenue ?? 0,
    });
  } catch (err) {
    console.error("Analytics error:", err.message);
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN — EVENT MANAGEMENT
// ─────────────────────────────────────────────────────────────

// GET /api/admin/events
// 3NF: events_view provides computed available_seats; 1NF: venue alias included
app.get("/api/admin/events", authenticateAdmin, async (req, res) => {
  try {
    const [events] = await pool.execute("SELECT * FROM events_view ORDER BY event_date ASC");
    res.json(events);
  } catch (err) {
    console.error("Admin events fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch events" });
  }
});

// POST /api/admin/events — creates event and auto-generates all seat records
// 1NF: venue split into venue_name (atomic) + venue_city (atomic)
// 3NF: available_seats removed from INSERT (computed in events_view)
app.post("/api/admin/events", authenticateAdmin, async (req, res) => {
  const { event_name, venue_name, venue_city, event_date, total_seats, ticket_price, sale_start_time,
    sections, rows_per_section, seats_per_row } = req.body;

  if (!event_name || !venue_name || !venue_city || !event_date || !total_seats || !ticket_price || !sale_start_time)
    return res.status(400).json({ error: "All event fields are required (include venue_name and venue_city)" });

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const event_id = crypto.randomUUID();
    await conn.execute(
      // 1NF: venue_name + venue_city stored separately. 3NF: available_seats omitted (computed view)
      `INSERT INTO events
         (event_id, event_name, venue_name, venue_city, event_date, total_seats, ticket_price, sale_start_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [event_id, event_name, venue_name, venue_city, event_date,
        Number(total_seats),
        Number(ticket_price), sale_start_time]
    );

    // Auto-generate seat records from section/row/seat layout
    const sectionLabels = (sections || "A,B,C").split(",").map(s => s.trim()).filter(Boolean);
    const rowCount = Math.max(1, Number(rows_per_section) || 4);
    const seatCount = Math.max(1, Number(seats_per_row) || 5);
    const seatInserts = [];
    const seatValues = [];

    for (const section of sectionLabels) {
      for (let r = 1; r <= rowCount; r++) {
        for (let s = 1; s <= seatCount; s++) {
          seatInserts.push("(UUID(), ?, ?, ?, ?, 'AVAILABLE')");
          seatValues.push(event_id, section, String(r), s);
        }
      }
    }

    if (seatInserts.length > 0) {
      await conn.execute(
        `INSERT INTO seats (seat_id, event_id, section, row_label, seat_number, status)
         VALUES ${seatInserts.join(",")}`,
        seatValues
      );
      // 3NF: available_seats removed from events (computed in events_view — no UPDATE needed)
      const actualSeats = seatInserts.length;
      await conn.execute(
        "UPDATE events SET total_seats = ? WHERE event_id = ?",
        [actualSeats, event_id]
      );
    }

    await conn.commit();

    const [[event]] = await conn.execute(
      "SELECT * FROM events WHERE event_id = ?",
      [event_id]
    );
    res.status(201).json({ success: true, event });
  } catch (err) {
    await conn.rollback();
    console.error("Admin create event error:", err.message);
    res.status(500).json({ error: "Failed to create event: " + err.message });
  } finally {
    conn.release();
  }
});

// DELETE /api/admin/events/:event_id — cascades to seats, tickets, queues via FK constraints
app.delete("/api/admin/events/:event_id", authenticateAdmin, async (req, res) => {
  const { event_id } = req.params;
  try {
    await pool.execute("DELETE FROM events WHERE event_id = ?", [event_id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Admin delete event error:", err.message);
    res.status(500).json({ error: "Failed to delete event: " + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// ANTI-BOT — Suspicious Login Detection
// Flags IPs with more than 10 failed login attempts in the last hour
// ─────────────────────────────────────────────────────────────

// GET /api/admin/suspicious-logins
app.get("/api/admin/suspicious-logins", authenticateAdmin, async (req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT ip_address, COUNT(*) AS attempts, MAX(attempted_at) AS last_attempt
      FROM login_attempts
      WHERE success = FALSE AND attempted_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
      GROUP BY ip_address
      HAVING COUNT(*) > 10
      ORDER BY attempts DESC
    `);
    res.json(rows);
  } catch (err) {
    console.error("Suspicious logins fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch suspicious login data" });
  }
});
