-- ─────────────────────────────────────────────────────────────
-- FairTicket — Seed Data
-- Run AFTER schema.sql in MySQL Workbench
-- ─────────────────────────────────────────────────────────────

USE fairticket;

-- ── ADMIN USER ────────────────────────────────────────────────
-- Email: admin@fairticket.com
-- Password: Admin@1234
-- Password hash generated with bcrypt rounds=12
-- (regenerate with: node -e "const b=require('bcryptjs');b.hash('Admin@1234',12).then(console.log)")

-- 1NF: name split into first_name + last_name
INSERT INTO users
  (user_id, first_name, last_name, email, phone, password_hash, is_admin)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'FairTicket',
  'Admin',
  'admin@fairticket.com',
  '+91-9000000000',
  '$2a$12$p2rHagJq5wmzSdE69tGHMO2900HxVq0252S5L7nJntKqxWUdP1UTi',
  TRUE
)
ON DUPLICATE KEY UPDATE password_hash = '$2a$12$p2rHagJq5wmzSdE69tGHMO2900HxVq0252S5L7nJntKqxWUdP1UTi';

-- ── TEST USER ─────────────────────────────────────────────────
-- Email: user@fairticket.com
-- Password: User@1234

-- 1NF: name split into first_name + last_name
INSERT INTO users
  (user_id, first_name, last_name, email, phone, password_hash, is_admin)
VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'Test',
  'User',
  'user@fairticket.com',
  '+91-9000000001',
  '$2a$12$wR78bhWnS2PAwMTcd2svL.FO3RhBrOWboDjBLX5pS9bysfMdRk8Aa',
  FALSE
)
ON DUPLICATE KEY UPDATE password_hash = '$2a$12$wR78bhWnS2PAwMTcd2svL.FO3RhBrOWboDjBLX5pS9bysfMdRk8Aa';

-- ── EVENTS ───────────────────────────────────────────────────

SET @ipl  = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
SET @wc   = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
SET @cnc  = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
SET @f1   = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

-- 1NF: venue split into venue_name + venue_city (atomic)
-- 3NF: available_seats removed (computed live in events_view)
INSERT IGNORE INTO events
  (event_id, event_name, venue_name, venue_city, event_date, total_seats, ticket_price, sale_start_time)
VALUES
  (@ipl,  'IPL Final 2026',                     'Wankhede Stadium',            'Mumbai',        '2026-05-30', 60, 4500.00,  '2026-04-10 10:00:00'),
  (@wc,   'FIFA World Cup Final 2026',           'MetLife Stadium',             'New York',      '2026-07-19', 60, 15000.00, '2026-04-15 12:00:00'),
  (@cnc,  'Coldplay: Music of the Spheres Tour', 'Narendra Modi Stadium',       'Ahmedabad',     '2026-06-14', 60, 8000.00,  '2026-04-12 09:00:00'),
  (@f1,   'Formula 1 India Grand Prix 2026',     'Buddh International Circuit', 'Greater Noida', '2026-10-18', 60, 6500.00,  '2026-04-20 11:00:00');

-- ── SEATS — 3 sections × 4 rows × 5 seats = 60 per event ─────
-- Sections: A (Premium), B (General), C (Economy)
-- Rows: 1–4 per section, seats 1–5 per row

DROP PROCEDURE IF EXISTS seed_seats;

DELIMITER //

CREATE PROCEDURE seed_seats(IN p_event_id CHAR(36), IN p_price_tier VARCHAR(10))
BEGIN
  DECLARE s INT DEFAULT 0;  -- section index 0,1,2
  DECLARE r INT;
  DECLARE seat INT;
  DECLARE section_name VARCHAR(10);

  WHILE s < 3 DO
    CASE s
      WHEN 0 THEN SET section_name = 'A';
      WHEN 1 THEN SET section_name = 'B';
      ELSE        SET section_name = 'C';
    END CASE;

    SET r = 1;
    WHILE r <= 4 DO
      SET seat = 1;
      WHILE seat <= 5 DO
        INSERT IGNORE INTO seats (seat_id, event_id, section, row_label, seat_number, status)
        VALUES (UUID(), p_event_id, section_name, CAST(r AS CHAR), seat, 'AVAILABLE');
        SET seat = seat + 1;
      END WHILE;
      SET r = r + 1;
    END WHILE;

    SET s = s + 1;
  END WHILE;
END //

DELIMITER ;

CALL seed_seats(@ipl,  'standard');
CALL seed_seats(@wc,   'standard');
CALL seed_seats(@cnc,  'standard');
CALL seed_seats(@f1,   'standard');

DROP PROCEDURE IF EXISTS seed_seats;

-- ── VERIFICATION SUMMARY ──────────────────────────────────────

SELECT 'users'           AS tbl, COUNT(*) AS row_count FROM users
UNION ALL
SELECT 'events',                  COUNT(*)              FROM events
UNION ALL
SELECT 'seats',                   COUNT(*)              FROM seats;

-- ─────────────────────────────────────────────────────────────
-- Login credentials for testing:
--
--   Admin  → admin@fairticket.com  / Admin@1234
--   User   → user@fairticket.com   / User@1234
-- ─────────────────────────────────────────────────────────────
