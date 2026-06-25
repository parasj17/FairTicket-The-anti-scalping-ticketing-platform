/**
 * FairTicket — frontend/app.js
 * Contribution: Pranav Bhoj
 *
 * Covers:
 *   - Global state management
 *   - API fetch helper (with JWT header injection)
 *   - UI utilities: loader, toast notifications, formatters
 *   - Auth tab switcher (Login / Register)
 *   - handleLogin(), handleRegister(), persistSession(), handleLogout()
 *   - bootApp() — shows the main app after auth
 *   - navigate() — SPA client-side router
 *   - toggleMobileMenu()
 *   - loadEvents() — fetches and renders event cards
 *   - openEventSeats() — opens the seat map for a selected event
 *   - renderSeatMap() — renders seat grid grouped by section/row
 *   - selectSeat() — toggles seat selection (max 4)
 *   - updateSelectionBar() — sticky selection count + total price bar
 *   - clearSeatSelection()
 *   - openBookingModal() — shows booking summary modal
 *   - confirmBooking() — submits atomic booking request to backend
 *   - init() — bootstraps app on page load
 */

const API = "http://localhost:3001/api";

// ─────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────
const state = {
  token:        localStorage.getItem("ft_token") || null,
  user:         JSON.parse(localStorage.getItem("ft_user") || "null"),
  currentPage:  "events",
  selectedSeats: [],        // array — supports up to 4
  selectedEvent: null,
  pendingResaleTicketId: null,
  pendingResaleOrigPrice: null,
};

// ─────────────────────────────────────────────────────────────
// API HELPERS
// ─────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
  const res = await fetch(`${API}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showLoader() { document.getElementById("loader").classList.remove("hidden"); }
function hideLoader() { document.getElementById("loader").classList.add("hidden"); }

let toastTimer;
function showToast(msg, type = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

function fmt$(n)   { return n != null ? `₹${Number(n).toFixed(2)}` : "—"; }
function fmtDate(d) { return d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"; }

function closeModal(id) { document.getElementById(id).classList.add("hidden"); }
function renderEmpty(msg = "Nothing here yet.") { return `<div class="empty-state">🎭 ${msg}</div>`; }

// ─────────────────────────────────────────────────────────────
// AUTH TAB SWITCHER
// ─────────────────────────────────────────────────────────────
function showAuthTab(tab) {
  const isLogin = tab === "login";
  document.getElementById("form-login").classList.toggle("hidden", !isLogin);
  document.getElementById("form-register").classList.toggle("hidden", isLogin);
  document.getElementById("tab-login").classList.toggle("active", isLogin);
  document.getElementById("tab-register").classList.toggle("active", !isLogin);
}

// ─────────────────────────────────────────────────────────────
// AUTH HANDLERS
// ─────────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const email    = document.getElementById("login-email").value.trim();
  const password = document.getElementById("login-password").value;
  const btn = document.getElementById("btn-login");
  btn.disabled = true; btn.textContent = "Signing in…";

  try {
    const data = await apiFetch("/login", { method: "POST", body: JSON.stringify({ email, password }) });
    persistSession(data.token, data.user);
    bootApp();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Sign In";
  }
}

// 1NF: Registration now sends first_name + last_name (atomic) instead of a single name field
async function handleRegister(e) {
  e.preventDefault();
  const first_name = document.getElementById("reg-first-name").value.trim();
  const last_name  = document.getElementById("reg-last-name").value.trim();
  const email      = document.getElementById("reg-email").value.trim();
  const phone      = document.getElementById("reg-phone").value.trim();
  const password   = document.getElementById("reg-password").value;
  const btn = document.getElementById("btn-register");
  btn.disabled = true; btn.textContent = "Creating account…";

  try {
    const data = await apiFetch("/register", { method: "POST", body: JSON.stringify({ first_name, last_name, email, phone, password }) });
    persistSession(data.token, data.user);
    bootApp();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create Account";
  }
}

function persistSession(token, user) {
  state.token = token;
  state.user  = user;
  localStorage.setItem("ft_token", token);
  localStorage.setItem("ft_user", JSON.stringify(user));
}

function handleLogout() {
  state.token = null;
  state.user  = null;
  localStorage.removeItem("ft_token");
  localStorage.removeItem("ft_user");
  document.getElementById("view-app").classList.add("hidden");
  document.getElementById("view-auth").classList.remove("hidden");
  showAuthTab("login");
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
function bootApp() {
  document.getElementById("view-auth").classList.add("hidden");
  document.getElementById("view-app").classList.remove("hidden");

  // 1NF: user now has first_name + last_name; name alias retained for display
  const nameEl = document.getElementById("nav-username");
  if (nameEl) nameEl.textContent = state.user?.name
    || (state.user?.first_name ? `${state.user.first_name} ${state.user.last_name}` : state.user?.email)
    || "";

  if (state.user?.is_admin) {
    document.querySelectorAll(".admin-only").forEach(el => el.classList.remove("hidden"));
  }

  navigate("events");
}

// ─────────────────────────────────────────────────────────────
// NAVIGATION — SPA client-side router
// ─────────────────────────────────────────────────────────────
function navigate(page) {
  const adminPages = ["analytics", "scan"];
  if (adminPages.includes(page) && !state.user?.is_admin) {
    showToast("Access denied — admin only.", "error");
    page = "events";
  }

  state.currentPage = page;

  document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.remove("hidden");

  const navEl = document.getElementById(`nav-${page}`);
  if (navEl) navEl.classList.add("active");

  const loaders = {
    events:    loadEvents,
    mytickets: loadMyTickets,
    resale:    loadResale,
    queue:     loadQueueStatus,
    analytics: loadAnalytics,
  };
  loaders[page]?.();
}

function toggleMobileMenu() {
  document.getElementById("mobile-menu").classList.toggle("hidden");
}

// ─────────────────────────────────────────────────────────────
// EVENTS PAGE
// ─────────────────────────────────────────────────────────────
async function loadEvents() {
  const grid = document.getElementById("events-grid");
  grid.innerHTML = Array(3).fill('<div class="skeleton-card"></div>').join("");

  try {
    const events = await apiFetch("/events");
    if (!events.length) { grid.innerHTML = renderEmpty("No upcoming events found."); return; }

    grid.innerHTML = events.map(ev => {
      const sold = ev.available_seats <= 0;
      const evJson = JSON.stringify(ev).replace(/"/g, "&quot;");
      return `
        <article class="event-card" onclick="openEventSeats(${evJson})"
                 role="button" tabindex="0"
                 onkeydown="if(event.key==='Enter')openEventSeats(${evJson})">
          <div class="event-card-badge ${sold ? "badge-soldout" : "badge-available"}">
            ${sold ? "● Sold Out" : "● On Sale"}
          </div>
          <h2>${ev.event_name}</h2>
          <div class="event-venue">📍 ${ev.venue}</div>
          <div class="event-date">📅 ${fmtDate(ev.event_date)}</div>
          <div class="event-card-footer">
            <span class="event-price">${fmt$(ev.ticket_price)}</span>
            <span class="event-seats">${ev.available_seats} / ${ev.total_seats} seats left</span>
          </div>
        </article>`;
    }).join("");
  } catch (err) {
    grid.innerHTML = renderEmpty("Failed to load events: " + err.message);
    showToast(err.message, "error");
  }
}

// ─────────────────────────────────────────────────────────────
// SEATS PAGE
// ─────────────────────────────────────────────────────────────
async function openEventSeats(ev) {
  state.selectedEvent = ev;
  state.selectedSeats = [];

  document.querySelectorAll(".page").forEach(p => p.classList.add("hidden"));
  document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
  document.getElementById("page-seats").classList.remove("hidden");

  document.getElementById("seats-event-title").textContent = ev.event_name;
  document.getElementById("seats-event-meta").textContent  =
    `${ev.venue} · ${fmtDate(ev.event_date)} · ${fmt$(ev.ticket_price)} per ticket`;

  const seatMap = document.getElementById("seat-map");
  seatMap.innerHTML = '<div class="empty-state">Loading seats…</div>';

  try {
    const seats = await apiFetch(`/events/${ev.event_id}/seats`);
    renderSeatMap(seats);
  } catch (err) {
    seatMap.innerHTML = renderEmpty("Failed to load seats: " + err.message);
    showToast(err.message, "error");
  }
}

function renderSeatMap(seats) {
  const seatMap = document.getElementById("seat-map");
  if (!seats.length) { seatMap.innerHTML = renderEmpty("No seats available."); return; }

  // Group by section → row → seats
  const sections = {};
  seats.forEach(s => {
    (sections[s.section] = sections[s.section] || {})[s.row] =
      (sections[s.section][s.row] || []).concat(s);
  });

  let html = "";
  for (const section of Object.keys(sections).sort()) {
    html += `<div><div class="seat-section-label">Section ${section}</div>`;
    for (const row of Object.keys(sections[section]).sort()) {
      html += `<div class="seat-row"><span class="seat-row-label">${row}</span>`;
      for (const seat of sections[section][row].sort((a, b) => a.seat_number - b.seat_number)) {
        let cls = "seat-btn ";
        let attrs = `title="Row ${seat.row}, Seat ${seat.seat_number}"`;

        if (seat.is_locked) {
          cls += "locked";
          attrs += " disabled title='Seat is temporarily locked'";
        } else if (seat.status === "PURCHASED") {
          cls += "purchased";
          attrs += " disabled title='Already purchased'";
        } else {
          cls += "available";
        }

        const seatJson = JSON.stringify(seat).replace(/"/g, "&quot;");
        html += `<button ${attrs} class="${cls}" id="seat-${seat.seat_id}"
                  onclick="selectSeat(${seatJson})">${seat.seat_number}</button>`;
      }
      html += "</div>";
    }
    html += "</div>";
  }
  seatMap.innerHTML = html;
}

// Toggle seat in/out of selection (max 4)
function selectSeat(seat) {
  const idx = state.selectedSeats.findIndex(s => s.seat_id === seat.seat_id);

  if (idx !== -1) {
    state.selectedSeats.splice(idx, 1);
    const el = document.getElementById(`seat-${seat.seat_id}`);
    if (el) { el.classList.remove("selected"); el.classList.add("available"); }
  } else {
    if (state.selectedSeats.length >= 4) {
      showToast("Maximum 4 seats per booking. Deselect one first.", "error");
      return;
    }
    state.selectedSeats.push(seat);
    const el = document.getElementById(`seat-${seat.seat_id}`);
    if (el) { el.classList.remove("available"); el.classList.add("selected"); }
  }

  updateSelectionBar();
}

// Sticky bottom bar showing selection count + total price
function updateSelectionBar() {
  const bar   = document.getElementById("seat-selection-bar");
  const count = state.selectedSeats.length;
  if (!bar) return;

  if (count === 0) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  const total = count * Number(state.selectedEvent?.ticket_price || 0);
  document.getElementById("sel-count").textContent = `${count} seat${count > 1 ? "s" : ""} selected`;
  document.getElementById("sel-total").textContent  = fmt$(total);
  document.getElementById("sel-limit").textContent  = count >= 4 ? " (max reached)" : `  · ${4 - count} more allowed`;
}

function clearSeatSelection() {
  state.selectedSeats.forEach(s => {
    const el = document.getElementById(`seat-${s.seat_id}`);
    if (el) { el.classList.remove("selected"); el.classList.add("available"); }
  });
  state.selectedSeats = [];
  updateSelectionBar();
}

// ─────────────────────────────────────────────────────────────
// BOOKING MODAL
// ─────────────────────────────────────────────────────────────
function openBookingModal() {
  if (!state.selectedSeats.length || !state.selectedEvent) return;
  const ev = state.selectedEvent;
  const seatsRows = state.selectedSeats.map(s =>
    `<div class="row"><span>💺 ${s.section}-${s.row}-${s.seat_number}</span><span>${fmt$(ev.ticket_price)}</span></div>`
  ).join("");

  document.getElementById("booking-summary").innerHTML = `
    <div class="row"><span>Event</span><span>${ev.event_name}</span></div>
    <div class="row"><span>Venue</span><span>${ev.venue}</span></div>
    <div class="row"><span>Date</span><span>${fmtDate(ev.event_date)}</span></div>
    <div class="booking-seats-header">Selected Seats</div>
    ${seatsRows}
    <div class="row total">
      <span>Total (${state.selectedSeats.length} ticket${state.selectedSeats.length > 1 ? "s" : ""})</span>
      <span>${fmt$(state.selectedSeats.length * Number(ev.ticket_price))}</span>
    </div>
  `;
  document.getElementById("booking-modal").classList.remove("hidden");
}

// Submits all selected seats as one atomic booking request
async function confirmBooking() {
  if (!state.selectedSeats.length || !state.selectedEvent) return;
  const btn = document.getElementById("btn-confirm-book");
  btn.disabled = true; btn.textContent = "Processing…";

  try {
    const data = await apiFetch("/book", {
      method: "POST",
      body: JSON.stringify({
        seat_ids: state.selectedSeats.map(s => s.seat_id),
        event_id: state.selectedEvent.event_id,
      }),
    });
    closeModal("booking-modal");
    showToast(`🎉 ${data.tickets.length} ticket${data.tickets.length > 1 ? "s" : ""} booked! Check My Tickets.`, "success");

    const seats = await apiFetch(`/events/${state.selectedEvent.event_id}/seats`);
    state.selectedSeats = [];
    updateSelectionBar();
    renderSeatMap(seats);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Confirm & Purchase";
  }
}

// ─────────────────────────────────────────────────────────────
// INIT — bootstraps the app on page load
// ─────────────────────────────────────────────────────────────
(function init() {
  if (state.token && state.user) {
    bootApp();
  }

  // Close modals on backdrop click
  document.querySelectorAll(".modal-overlay").forEach(el => {
    el.addEventListener("click", e => { if (e.target === el) el.classList.add("hidden"); });
  });

  // Close mobile menu on outside click
  document.addEventListener("click", e => {
    const menu = document.getElementById("mobile-menu");
    const ham  = document.getElementById("nav-hamburger");
    if (menu && ham && !menu.contains(e.target) && !ham.contains(e.target)) {
      menu.classList.add("hidden");
    }
  });
})();
