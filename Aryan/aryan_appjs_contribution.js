/**
 * FairTicket — frontend/app.js
 * Contribution: Aryan Gurav
 *
 * Covers:
 *   - joinQueue()              — joins the virtual queue for an event
 *   - loadQueueStatus()        — fetches and renders the user's queue positions
 *   - loadMyTickets()          — fetches and renders purchased tickets
 *   - renderMyTickets()        — builds ticket card HTML
 *   - openResaleModal()        — opens the resale listing modal with price cap
 *   - confirmResaleListing()   — submits a resale listing to the backend
 *   - loadResale()             — fetches and renders active resale marketplace
 *   - buyResaleListing()       — purchases a resale ticket
 *   - loadAnalytics()          — fetches and renders admin analytics dashboard
 *   - loadAdminEvents()        — fetches and renders admin event list
 *   - handleCreateEvent()      — submits a new event creation form
 *   - handleDeleteEvent()      — deletes an event with confirmation
 *   - handleScan()             — submits a ticket ID for entry scanning
 */

// ─────────────────────────────────────────────────────────────
// QUEUE — join + status
// ─────────────────────────────────────────────────────────────

// Joins the virtual queue for the currently selected event
async function joinQueue() {
  if (!state.selectedEvent) return;
  try {
    const data = await apiFetch("/queue/join", {
      method: "POST",
      body: JSON.stringify({ event_id: state.selectedEvent.event_id }),
    });
    showToast(`You are #${data.position} in the queue! Visit "My Queue" to track it.`, "success");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Loads and renders all active queue positions for the logged-in user
async function loadQueueStatus() {
  const container = document.getElementById("queue-status-list");
  container.innerHTML = '<div class="empty-state">Loading queue positions…</div>';

  try {
    const queues = await apiFetch("/my-queues");
    if (!queues.length) {
      container.innerHTML = renderEmpty("You're not in any active queues. Join a queue from the Seats page.");
      return;
    }

    container.innerHTML = queues.map(q => {
      const seatsLeft = q.available_seats;
      const urgent = seatsLeft > 0 && q.queue_position <= seatsLeft;
      return `
        <div class="queue-card glass ${urgent ? "queue-card-urgent" : ""}">
          <div class="queue-card-left">
            ${urgent ? '<div class="queue-alert-dot"></div>' : ""}
            <div>
              <div class="queue-event-name">${q.event_name}</div>
              <div class="queue-event-meta">📍 ${q.venue} · 📅 ${fmtDate(q.event_date)}</div>
            </div>
          </div>
          <div class="queue-position-block">
            <div class="queue-position-number">#${q.queue_position}</div>
            <div class="queue-position-label">your position</div>
            ${urgent
              ? `<div class="queue-seats-alert">🎟 Seats available now!</div>`
              : `<div class="queue-seats-count">${seatsLeft} seat${seatsLeft !== 1 ? "s" : ""} remaining</div>`}
          </div>
          <button class="btn btn-secondary btn-sm"
                  onclick="openEventSeats(${JSON.stringify(q).replace(/"/g, "&quot;")})">
            View Seats
          </button>
        </div>`;
    }).join("");
  } catch (err) {
    container.innerHTML = renderEmpty("Failed to load queue data: " + err.message);
    showToast(err.message, "error");
  }
}

// ─────────────────────────────────────────────────────────────
// MY TICKETS
// ─────────────────────────────────────────────────────────────

async function loadMyTickets() {
  const grid = document.getElementById("my-tickets-grid");
  grid.innerHTML = '<div class="empty-state">Loading your tickets…</div>';

  try {
    const tickets = await apiFetch("/my-tickets");
    if (!tickets.length) {
      grid.innerHTML = renderEmpty("You haven't purchased any tickets yet. Browse events to get started!");
      return;
    }
    renderMyTickets(tickets);
  } catch (err) {
    grid.innerHTML = renderEmpty("Failed to load tickets: " + err.message);
    showToast(err.message, "error");
  }
}

function renderMyTickets(tickets) {
  const grid = document.getElementById("my-tickets-grid");
  grid.innerHTML = tickets.map(t => {
    const status    = (t.ticket_status || "PURCHASED").toUpperCase();
    const statusCls = `status-${status.toLowerCase().replace("_", "-")}`;
    const statusTxt = status.replace(/_/g, " ");
    const canResell = status === "PURCHASED";
    return `
      <div class="ticket-card">
        <div class="ticket-card-header">
          <div class="ticket-event-name">${t.event_name || "Unknown Event"}</div>
          <span class="ticket-status-badge ${statusCls}">${statusTxt}</span>
        </div>
        <div class="ticket-meta">
          <span>📍 ${t.venue || "—"}</span>
          <span>📅 ${fmtDate(t.event_date)}</span>
          <span>💺 Section ${t.section}, Row ${t.row}, Seat ${t.seat_number}</span>
          <span>🕐 Purchased ${fmtDate(t.purchase_time)}</span>
        </div>
        <div class="ticket-id-display">ID: ${t.ticket_id}</div>
        <div class="ticket-actions">
          ${canResell ? `<button class="btn btn-secondary btn-sm"
            onclick="openResaleModal('${t.ticket_id}', ${t.ticket_price})">
            List for Resale
          </button>` : ""}
        </div>
      </div>`;
  }).join("");
}

// Opens the resale modal — pre-fills max price from original ticket price
function openResaleModal(ticket_id, originalPrice) {
  state.pendingResaleTicketId   = ticket_id;
  state.pendingResaleOrigPrice  = parseFloat(originalPrice) || 0;
  const input = document.getElementById("resale-price");
  input.max   = state.pendingResaleOrigPrice;
  input.value = "";
  document.getElementById("resale-modal").classList.remove("hidden");
}

// Submits the resale listing — enforces price cap client-side (backend also validates)
async function confirmResaleListing() {
  const ticket_id = state.pendingResaleTicketId;
  const price     = parseFloat(document.getElementById("resale-price").value);

  if (!ticket_id || isNaN(price) || price <= 0) {
    showToast("Please enter a valid price.", "error"); return;
  }
  if (state.pendingResaleOrigPrice && price > state.pendingResaleOrigPrice) {
    showToast(`Price cannot exceed the original price of ${fmt$(state.pendingResaleOrigPrice)}.`, "error");
    return;
  }

  const btn = document.getElementById("btn-confirm-resale");
  btn.disabled = true; btn.textContent = "Listing…";
  try {
    await apiFetch("/resale", { method: "POST", body: JSON.stringify({ ticket_id, price }) });
    closeModal("resale-modal");
    showToast("Ticket listed for resale!", "success");
    loadMyTickets();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "List for Resale";
  }
}

// ─────────────────────────────────────────────────────────────
// RESALE MARKETPLACE
// ─────────────────────────────────────────────────────────────

async function loadResale() {
  const grid = document.getElementById("resale-grid");
  grid.innerHTML = '<div class="empty-state">Loading listings…</div>';

  try {
    const listings = await apiFetch("/resale");
    if (!listings.length) { grid.innerHTML = renderEmpty("No active resale listings at the moment."); return; }

    grid.innerHTML = listings.map(l => `
      <div class="resale-card">
        <h3>${l.event_name}</h3>
        <div class="resale-meta">
          <span>🧾 Seller: <b>${l.seller_name}</b></span>
          <span>📋 ID: ${l.listing_id.slice(0, 8)}…</span>
        </div>
        <div class="resale-price-row">
          <div>
            <div class="resale-price">${fmt$(l.price)}</div>
            <div class="resale-orig">Original: ${fmt$(l.original_price)}</div>
          </div>
          <button class="btn btn-success btn-sm" onclick="buyResaleListing('${l.listing_id}')">Buy Now</button>
        </div>
      </div>`).join("");
  } catch (err) {
    grid.innerHTML = renderEmpty("Failed to load listings: " + err.message);
    showToast(err.message, "error");
  }
}

async function buyResaleListing(listing_id) {
  if (!confirm("Confirm purchase of this resale ticket?")) return;
  showLoader();
  try {
    await apiFetch(`/resale/${listing_id}/buy`, { method: "POST" });
    showToast("🎉 Ticket purchased from resale!", "success");
    loadResale();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    hideLoader();
  }
}

// ─────────────────────────────────────────────────────────────
// ANALYTICS DASHBOARD (admin only)
// ─────────────────────────────────────────────────────────────
async function loadAnalytics() {
  ["kpi-revenue", "kpi-active-listings", "kpi-avg-resale", "kpi-sold-listings"]
    .forEach(id => { document.getElementById(id).textContent = "…"; });

  try {
    const [analytics, suspicious] = await Promise.all([
      apiFetch("/analytics"),
      apiFetch("/admin/suspicious-logins"),
    ]);

    document.getElementById("kpi-revenue").textContent         = fmt$(analytics.total_revenue);
    document.getElementById("kpi-active-listings").textContent = analytics.resale?.active_listings ?? 0;
    document.getElementById("kpi-avg-resale").textContent      = fmt$(analytics.resale?.avg_resale_price);
    document.getElementById("kpi-sold-listings").textContent   = analytics.resale?.sold_listings ?? 0;

    // Tickets sold bar chart
    const soldData = analytics.tickets_sold || [];
    const soldList = document.getElementById("tickets-sold-list");
    if (!soldData.length) {
      soldList.innerHTML = '<div class="empty-state" style="padding:1rem">No data yet</div>';
    } else {
      const max = Math.max(...soldData.map(x => Number(x.tickets_sold)), 1);
      soldList.innerHTML = soldData.map(x => `
        <div class="bar-item">
          <div class="bar-label"><span>${x.event_name}</span><span>${x.tickets_sold}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${(x.tickets_sold / max * 100).toFixed(1)}%"></div></div>
        </div>`).join("");
    }

    // Queue sizes bar chart
    const queueData = analytics.queue_sizes || [];
    const queueList = document.getElementById("queue-sizes-list");
    if (!queueData.length) {
      queueList.innerHTML = '<div class="empty-state" style="padding:1rem">No active queues</div>';
    } else {
      const maxQ = Math.max(...queueData.map(x => Number(x.queue_size)), 1);
      queueList.innerHTML = queueData.map(x => `
        <div class="bar-item">
          <div class="bar-label"><span>${x.event_id.slice(0, 8)}…</span><span>${x.queue_size}</span></div>
          <div class="bar-track"><div class="bar-fill" style="width:${(x.queue_size / maxQ * 100).toFixed(1)}%"></div></div>
        </div>`).join("");
    }

    // Suspicious login IPs
    const suspEl = document.getElementById("suspicious-logins-list");
    if (!suspicious.length) {
      suspEl.innerHTML = '<div class="empty-state" style="padding:1rem">✅ No suspicious activity detected</div>';
    } else {
      suspEl.innerHTML = suspicious.map(s => `
        <div class="suspicious-row">
          <span class="suspicious-ip">${s.ip_address}</span>
          <span class="suspicious-count">${s.attempts} failed · last: ${fmtDate(s.last_attempt)}</span>
        </div>`).join("");
    }
  } catch (err) {
    showToast("Analytics: " + err.message, "error");
  }

  loadAdminEvents();
}

// ─────────────────────────────────────────────────────────────
// ADMIN — EVENT MANAGEMENT
// ─────────────────────────────────────────────────────────────
async function loadAdminEvents() {
  const container = document.getElementById("admin-events-list");
  if (!container) return;
  container.innerHTML = '<div class="empty-state" style="padding:1rem">Loading events…</div>';

  try {
    const events = await apiFetch("/admin/events");
    if (!events.length) {
      container.innerHTML = '<div class="empty-state" style="padding:1rem">No events yet. Create one above.</div>';
      return;
    }
    container.innerHTML = events.map(ev => `
      <div class="admin-event-row">
        <div class="admin-event-info">
          <div class="admin-event-name">${ev.event_name}</div>
          <div class="admin-event-meta">
            📍 ${ev.venue_name}, ${ev.venue_city}
            &nbsp;·&nbsp; 📅 ${fmtDate(ev.event_date)}
            &nbsp;·&nbsp; 🏷️ ${fmt$(ev.ticket_price)}
            &nbsp;·&nbsp; 👤 ${ev.available_seats}/${ev.total_seats} seats
          </div>
        </div>
        <button class="btn btn-danger btn-sm"
                onclick="handleDeleteEvent('${ev.event_id}', '${ev.event_name.replace(/'/g, "\\'")}')"
                title="Delete event">
          Delete
        </button>
      </div>
    `).join("");
  } catch (err) {
    container.innerHTML = `<div class="empty-state" style="padding:1rem">Failed to load: ${err.message}</div>`;
  }
}

// 1NF: venue split into venue_name + venue_city — sent as separate atomic fields
async function handleCreateEvent(e) {
  e.preventDefault();
  const btn = document.getElementById("btn-create-event");
  btn.disabled = true; btn.textContent = "Creating…";

  const payload = {
    event_name:       document.getElementById("ev-name").value.trim(),
    venue_name:       document.getElementById("ev-venue-name").value.trim(),   // 1NF: atomic
    venue_city:       document.getElementById("ev-venue-city").value.trim(),   // 1NF: atomic
    event_date:       document.getElementById("ev-date").value,
    ticket_price:     parseFloat(document.getElementById("ev-price").value),
    sale_start_time:  document.getElementById("ev-sale-start").value.replace("T", " ") + ":00",
    sections:         document.getElementById("ev-sections").value.trim() || "A,B,C",
    rows_per_section: parseInt(document.getElementById("ev-rows").value)  || 4,
    seats_per_row:    parseInt(document.getElementById("ev-seats").value) || 5,
  };
  payload.total_seats = payload.sections.split(",").length
                        * payload.rows_per_section
                        * payload.seats_per_row;

  try {
    const data = await apiFetch("/admin/events", { method: "POST", body: JSON.stringify(payload) });
    showToast(`✅ "${data.event.event_name}" created!`, "success");
    document.getElementById("form-create-event").reset();
    document.getElementById("ev-sections").value = "A,B,C";
    document.getElementById("ev-rows").value = "4";
    document.getElementById("ev-seats").value = "5";
    loadAdminEvents();
  } catch (err) {
    showToast("Create event failed: " + err.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Create Event & Generate Seats";
  }
}

async function handleDeleteEvent(event_id, event_name) {
  if (!confirm(`Delete "${event_name}"?\nThis will remove all associated seats, tickets, and queue entries.`)) return;
  try {
    await apiFetch(`/admin/events/${event_id}`, { method: "DELETE" });
    showToast(`"${event_name}" deleted.`, "info");
    loadAdminEvents();
    loadEvents();
  } catch (err) {
    showToast("Delete failed: " + err.message, "error");
  }
}

// ─────────────────────────────────────────────────────────────
// SCAN — Entry Gate (admin only)
// ─────────────────────────────────────────────────────────────
async function handleScan(e) {
  e.preventDefault();
  const ticket_id = document.getElementById("scan-ticket-id").value.trim();
  const resultEl  = document.getElementById("scan-result");
  resultEl.className = "scan-result hidden";

  showLoader();
  try {
    await apiFetch("/scan", { method: "POST", body: JSON.stringify({ ticket_id }) });
    resultEl.className = "scan-result success";
    resultEl.innerHTML = "✅ <strong>Entry granted</strong> — Ticket is valid and has been marked as USED.";
    document.getElementById("scan-ticket-id").value = "";
  } catch (err) {
    resultEl.className = "scan-result error";
    resultEl.innerHTML = `❌ <strong>Denied:</strong> ${err.message}`;
  } finally {
    hideLoader();
  }
}
