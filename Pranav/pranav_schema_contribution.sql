-- ─────────────────────────────────────────────────────────────
-- FairTicket — MySQL 8.0 Schema
-- Contribution: Pranav Bhoj
--
-- Primary responsibility:
--   ○  users, events, seats, tickets  ← authored by Paras
--   ✅ ticket_queue, seat_locks, resale_market,
--      ticket_scan_logs, login_attempts  ← authored by Pranav
--   ✅ prevent_scalping BEFORE INSERT trigger
--   ✅ Indexes on anti-scalping tables
--   ✅ events_view — replaces removed available_seats column (3NF)
--
-- Normalization applied:
--   BCNF: ticket_queue — UNIQUE on (event_id, user_id)        [CK1]
--   BCNF: ticket_queue — UNIQUE on (event_id, queue_position) [CK2]
--   3NF : prevent_scalping trigger updated — tickets.event_id removed,
--           now joins tickets → seats → events to find face-value price
-- ─────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════
-- SECTION 2 — ANTI-SCALPING & SECURITY TABLES  [Pranav Bhoj]
-- ══════════════════════════════════════════════════════════════

-- BCNF Fix: Declare both candidate keys as UNIQUE constraints.
--   CK1 (event_id, user_id)        — a user can only queue once per event
--   CK2 (event_id, queue_position) — each position is unique per event
-- Without these constraints these functional dependencies existed but
-- were not enforced by the DBMS, violating BCNF.
CREATE TABLE ticket_queue (
  queue_id       CHAR(36)    PRIMARY KEY,
  event_id       CHAR(36)    NOT NULL,
  user_id        CHAR(36)    NOT NULL,
  queue_position INT         NOT NULL,
  entry_time     DATETIME    DEFAULT NOW(),
  status         VARCHAR(20) DEFAULT 'WAITING',
  FOREIGN KEY (event_id) REFERENCES events(event_id),
  FOREIGN KEY (user_id)  REFERENCES users(user_id),
  UNIQUE KEY uq_user_per_event     (event_id, user_id),       -- BCNF: CK1
  UNIQUE KEY uq_position_per_event (event_id, queue_position) -- BCNF: CK2
);

-- Temporarily holds a seat after purchase (5-minute grace period)
CREATE TABLE seat_locks (
  lock_id    CHAR(36)  PRIMARY KEY,
  seat_id    CHAR(36)  UNIQUE NOT NULL,
  user_id    CHAR(36)  NOT NULL,
  lock_time  DATETIME  DEFAULT NOW(),
  expires_at DATETIME  NOT NULL,
  FOREIGN KEY (seat_id)  REFERENCES seats(seat_id),
  FOREIGN KEY (user_id)  REFERENCES users(user_id)
);

-- Resale marketplace with DB-level price enforcement via trigger below
CREATE TABLE resale_market (
  listing_id CHAR(36)      PRIMARY KEY,
  ticket_id  CHAR(36)      NOT NULL,
  seller_id  CHAR(36)      NOT NULL,
  price      DECIMAL(10,2) NOT NULL,
  listed_at  DATETIME      DEFAULT NOW(),
  status     VARCHAR(20)   DEFAULT 'ACTIVE',
  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id),
  FOREIGN KEY (seller_id) REFERENCES users(user_id)
);

-- Every scan logged here; second scan on same ticket_id = duplicate → rejected
CREATE TABLE ticket_scan_logs (
  log_id     CHAR(36) PRIMARY KEY,
  ticket_id  CHAR(36) NOT NULL,
  scanned_at DATETIME DEFAULT NOW(),
  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
);

-- Logs every login attempt per IP for bot/suspicious activity detection
CREATE TABLE login_attempts (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      CHAR(36),
  ip_address   VARCHAR(100),
  success      BOOLEAN,
  attempted_at DATETIME DEFAULT NOW()
);

-- ══════════════════════════════════════════════════════════════
-- SECTION 3 — INDEXES  [Pranav Bhoj — anti-scalping tables]
--             + core table indexes  [Paras Jadhav]
-- ══════════════════════════════════════════════════════════════

CREATE INDEX idx_events_date        ON events(event_date);           -- [Paras]
CREATE INDEX idx_tickets_owner      ON tickets(owner_user_id);       -- [Paras]
CREATE INDEX idx_seats_event_status ON seats(event_id, status);      -- [Paras]
CREATE INDEX idx_seat_locks_seat    ON seat_locks(seat_id);          -- [Pranav]
CREATE INDEX idx_queue_event_pos    ON ticket_queue(event_id, queue_position); -- [Pranav]

-- ══════════════════════════════════════════════════════════════
-- SECTION 4a — VIEW: events_view  [Pranav Bhoj]
--
-- 3NF Fix: Replaces the removed events.available_seats column.
-- available_seats is a derived value (total_seats − booked count).
-- Storing it created a risk of inconsistency. This view computes it
-- live from the seats table — single source of truth, always accurate.
-- Also provides backward-compatible `venue` alias via CONCAT.
-- ══════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW events_view AS
SELECT
  e.event_id,
  e.event_name,
  e.venue_name,
  e.venue_city,
  CONCAT(e.venue_name, ', ', e.venue_city) AS venue,   -- backward-compat alias
  e.event_date,
  e.total_seats,
  e.ticket_price,
  e.sale_start_time,
  COALESCE(SUM(CASE WHEN s.status = 'AVAILABLE' THEN 1 ELSE 0 END), 0) AS available_seats
FROM events e
LEFT JOIN seats s ON s.event_id = e.event_id
GROUP BY
  e.event_id, e.event_name, e.venue_name, e.venue_city,
  e.event_date, e.total_seats, e.ticket_price, e.sale_start_time;

-- ══════════════════════════════════════════════════════════════
-- SECTION 5 — ANTI-SCALPING TRIGGER  [Pranav Bhoj]
--
-- Fires BEFORE every INSERT into resale_market.
-- Looks up the original ticket price and raises a SQLSTATE error
-- if the new listing price exceeds it — enforcement at DB level,
-- impossible to bypass even with direct SQL access.
--
-- 3NF Update: tickets.event_id was removed (transitive dependency).
-- The join path is now: tickets → seats → events
-- to find the face-value price.
-- ══════════════════════════════════════════════════════════════

DROP TRIGGER IF EXISTS prevent_scalping;

DELIMITER //
CREATE TRIGGER prevent_scalping
  BEFORE INSERT ON resale_market
  FOR EACH ROW
BEGIN
  DECLARE orig_price DECIMAL(10,2);

  -- 3NF fix: tickets no longer stores event_id directly.
  -- Join path: tickets → seats → events to find the face-value price.
  SELECT e.ticket_price INTO orig_price
  FROM tickets t
  JOIN seats  s ON t.seat_id   = s.seat_id
  JOIN events e ON s.event_id  = e.event_id
  WHERE t.ticket_id = NEW.ticket_id;

  -- Block the INSERT if resale price exceeds original
  IF NEW.price > orig_price THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Resale price exceeds original ticket price — scalping prevented';
  END IF;
END //
DELIMITER ;
