-- ─────────────────────────────────────────────────────────────
-- FairTicket — MySQL 8.0 Schema
-- Contribution: Paras Jadhav
--
-- Primary responsibility:
--   ✅ Database creation
--   ✅ users, events, seats, tickets  ← authored by Paras
--   ○  ticket_queue, seat_locks, resale_market,
--      ticket_scan_logs, login_attempts  ← authored by Pranav
--   ✅ Performance indexes on core tables
--
-- Normalization applied (schema.sql — normalized to BCNF):
--   1NF : users.name       → first_name + last_name (atomic attributes)
--   1NF : events.venue     → venue_name + venue_city (atomic attributes)
--   3NF : events.available_seats removed — derived value, now computed
--           live in events_view via SUM of seats with status='AVAILABLE'
--   3NF : tickets.event_id removed — transitively dependent:
--           ticket_id → seat_id → seats.event_id
--   BCNF: seats — UNIQUE on (event_id, section, row_label, seat_number)
--   BCNF: tickets — seat_id UNIQUE (one active ticket per physical seat)
-- ─────────────────────────────────────────────────────────────

CREATE DATABASE IF NOT EXISTS fairticket
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE fairticket;

-- ══════════════════════════════════════════════════════════════
-- SECTION 1 — CORE TABLES  [Paras Jadhav]
-- ══════════════════════════════════════════════════════════════

-- 1NF Fix: name (composite) → first_name + last_name (atomic attributes)
-- A single name TEXT field was not atomic — it combined two distinct facts.
CREATE TABLE users (
  user_id          CHAR(36)     PRIMARY KEY,
  first_name       VARCHAR(100) NOT NULL,          -- 1NF: was part of name TEXT
  last_name        VARCHAR(100) NOT NULL,          -- 1NF: was part of name TEXT
  email            VARCHAR(255) UNIQUE NOT NULL,
  phone            VARCHAR(50),
  verified_id_hash TEXT,
  password_hash    TEXT         NOT NULL,
  is_admin         BOOLEAN      DEFAULT FALSE,
  created_at       DATETIME     DEFAULT NOW()
);

-- 1NF Fix: venue (composite) → venue_name + venue_city (atomic attributes)
--   "Wankhede Stadium, Mumbai" was two facts stored in one column.
-- 3NF Fix: available_seats removed — it is a derived value:
--   available_seats = total_seats − COUNT(booked seats)
--   Storing it creates two sources of truth and risks inconsistency.
--   Use events_view (created by Pranav section) to get live counts.
CREATE TABLE events (
  event_id        CHAR(36)      PRIMARY KEY,
  event_name      VARCHAR(255)  NOT NULL,
  venue_name      VARCHAR(255)  NOT NULL,          -- 1NF: was part of venue TEXT
  venue_city      VARCHAR(100)  NOT NULL,          -- 1NF: was part of venue TEXT
  event_date      DATE          NOT NULL,
  total_seats     INT           NOT NULL,
  -- available_seats REMOVED (3NF): derived from seats table; see events_view
  ticket_price    DECIMAL(10,2) NOT NULL,
  sale_start_time DATETIME      NOT NULL
);

-- BCNF Fix: Add UNIQUE on the natural composite candidate key.
--   (event_id, section, row_label, seat_number) → seat_id
--   This functional dependency existed logically but was not declared
--   as a DB constraint, so the DBMS could not enforce BCNF compliance.
CREATE TABLE seats (
  seat_id     CHAR(36)    PRIMARY KEY,
  event_id    CHAR(36)    NOT NULL,
  section     VARCHAR(50) NOT NULL,
  row_label   VARCHAR(10) NOT NULL,
  seat_number INT         NOT NULL,
  status      VARCHAR(20) DEFAULT 'AVAILABLE'
              CHECK (status IN ('AVAILABLE', 'RESERVED', 'PURCHASED')),
  FOREIGN KEY (event_id) REFERENCES events(event_id) ON DELETE CASCADE,
  UNIQUE KEY uq_seat_identity (event_id, section, row_label, seat_number)  -- BCNF
);

-- 3NF Fix: event_id removed.
--   Dependency chain: ticket_id → seat_id → (seats.event_id) = event_id
--   Storing event_id in tickets is a transitive dependency — it could
--   differ from seats.event_id and cause silent inconsistency.
--   All queries obtain event via: JOIN seats ON seat_id, JOIN events ON event_id.
--
-- BCNF Fix: seat_id UNIQUE — each physical seat can have exactly one ticket.
--   Without this, two tickets could reference the same seat (double-booking at DB level).
CREATE TABLE tickets (
  ticket_id     CHAR(36)    PRIMARY KEY,
  -- event_id REMOVED (3NF): derive via JOIN seats s ON seat_id, s.event_id
  seat_id       CHAR(36)    UNIQUE NOT NULL,  -- BCNF: one-ticket-per-seat enforced
  owner_user_id CHAR(36)    NOT NULL,
  purchase_time DATETIME    DEFAULT NOW(),
  ticket_status VARCHAR(20) DEFAULT 'PURCHASED'
                CHECK (ticket_status IN ('RESERVED','PURCHASED','RESALE_LISTED','USED')),
  FOREIGN KEY (seat_id)       REFERENCES seats(seat_id),
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id)
);
