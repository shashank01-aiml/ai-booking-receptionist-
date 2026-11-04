import { useEffect, useMemo, useState } from "react";
import "./App.css";

const API_URL = "http://localhost:5000";

type Booking = {
  id: number;
  restaurant_name: string;
  table_number: string | number;
  table_capacity?: number;
  customer_name: string;
  phone: string;
  reservation_date: string;
  reservation_time: string;
  guests: number;
  status: string;
};

type DiningTable = {
  id: number;
  table_number: string | number;
  capacity: number;
};

const RESTAURANT_HOURS = [
  "11:00",
  "12:00",
  "13:00",
  "14:00",
  "15:00",
  "16:00",
  "17:00",
  "18:00",
  "19:00",
  "20:00",
  "21:00",
  "22:00",
];

function getTodayIso(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timeToMinutes(timeStr: string): number {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function isOverlapping(t1: string, t2: string, windowMin = 60): boolean {
  return Math.abs(timeToMinutes(t1) - timeToMinutes(t2)) < windowMin;
}

function addOneHour(timeStr: string): string {
  if (!timeStr) return "";
  const [h, m] = timeStr.split(":").map(Number);
  const endH = (h + 1) % 24;
  return `${String(endH).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
}

function formatDisplayDate(iso: string): string {
  try {
    const [y, m, d] = iso.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return date.toLocaleDateString("en-US", {
      weekday: "long",
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function generateDateList(baseDateStr: string, rangeDays = 14) {
  const list = [];
  const [y, m, d] = baseDateStr.split("-").map(Number);
  const start = new Date(y, m - 1, d);
  start.setDate(start.getDate() - 1); // include yesterday

  for (let i = 0; i < rangeDays; i++) {
    const cur = new Date(start);
    cur.setDate(start.getDate() + i);

    const year = cur.getFullYear();
    const month = String(cur.getMonth() + 1).padStart(2, "0");
    const day = String(cur.getDate()).padStart(2, "0");
    const iso = `${year}-${month}-${day}`;

    const dayName = cur.toLocaleDateString("en-US", { weekday: "short" }).toUpperCase();
    const dayNum = String(cur.getDate()).padStart(2, "0");
    const monthName = cur.toLocaleDateString("en-US", { month: "short" }).toUpperCase();

    list.push({ iso, dayName, dayNum, monthName });
  }
  return list;
}

function App() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [tables, setTables] = useState<DiningTable[]>([]);
  const [search, setSearch] = useState("");
  const [selectedBookingId, setSelectedBookingId] = useState<number | null>(null);

  // Selected Date and Hour for date-wise & hour-wise inspection
  const [selectedDate, setSelectedDate] = useState<string>(getTodayIso());
  const [selectedTime, setSelectedTime] = useState<string>("18:00");
  const [dateFilterMode, setDateFilterMode] = useState<"all" | "selected">("all");

  const [arrivedBookingIds, setArrivedBookingIds] = useState<number[]>([]);
  const [assignmentTable, setAssignmentTable] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [lastSynced, setLastSynced] = useState("");

  const selectedBooking = useMemo(
    () => bookings.find((booking) => booking.id === selectedBookingId) || null,
    [bookings, selectedBookingId]
  );

  const dateItems = useMemo(() => {
    return generateDateList(getTodayIso(), 16);
  }, []);

  // Bookings filtered for search or date tab
  const filteredBookings = useMemo(() => {
    let list = bookings;

    if (dateFilterMode === "selected" && selectedDate) {
      list = list.filter((b) => b.reservation_date === selectedDate);
    }

    const searchValue = search.toLowerCase().trim();
    if (!searchValue) {
      return list;
    }

    return list.filter((booking) => {
      return (
        String(booking.id).includes(searchValue) ||
        booking.customer_name.toLowerCase().includes(searchValue) ||
        booking.phone.toLowerCase().includes(searchValue) ||
        booking.reservation_date.includes(searchValue) ||
        String(booking.table_number).toLowerCase().includes(searchValue)
      );
    });
  }, [bookings, search, dateFilterMode, selectedDate]);

  // All bookings for selected date and hour (including cancelled)
  const hourBookings = useMemo(() => {
    return bookings.filter((b) => {
      if (b.reservation_date !== selectedDate) return false;
      return isOverlapping(b.reservation_time, selectedTime, 60);
    });
  }, [bookings, selectedDate, selectedTime]);

  const hourConfirmedBookings = useMemo(() => {
    return hourBookings.filter(
      (b) => b.status === "confirmed" || b.status === "arrived"
    );
  }, [hourBookings]);

  const hourCancelledBookings = useMemo(() => {
    return hourBookings.filter((b) => b.status === "cancelled");
  }, [hourBookings]);

  const hourOccupiedTableNumbers = useMemo(() => {
    return new Set(hourConfirmedBookings.map((b) => String(b.table_number)));
  }, [hourConfirmedBookings]);

  const availableTablesCount = useMemo(() => {
    return Math.max(0, tables.length - hourOccupiedTableNumbers.size);
  }, [tables, hourOccupiedTableNumbers]);

  async function loadBookings() {
    try {
      setError("");
      const response = await fetch(`${API_URL}/api/bookings`, {
        method: "GET",
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Bookings request failed: ${response.status}`);
      }

      const data = await response.json();
      const bookingList: Booking[] = Array.isArray(data)
        ? data
        : data.bookings || data.reservations || data.data || [];

      setBookings(bookingList);
      setLastSynced(new Date().toLocaleTimeString());
    } catch (requestError) {
      console.error("Unable to load bookings:", requestError);
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to connect to the backend"
      );
    } finally {
      setIsLoading(false);
    }
  }

  async function loadTables() {
    try {
      const response = await fetch(`${API_URL}/api/tables`, {
        cache: "no-store",
      });

      if (!response.ok) {
        return;
      }

      const data = await response.json();
      const tableList: DiningTable[] = Array.isArray(data)
        ? data
        : data.tables || data.data || [];

      setTables(tableList);
    } catch (requestError) {
      console.warn("Tables could not be loaded:", requestError);
    }
  }

  useEffect(() => {
    loadBookings();
    loadTables();

    const interval = window.setInterval(() => {
      loadBookings();
      loadTables();
    }, 2000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  async function assignTable() {
    if (!selectedBooking || !assignmentTable) {
      return;
    }

    try {
      setError("");
      const response = await fetch(
        `${API_URL}/api/bookings/${selectedBooking.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            tableNumber: assignmentTable,
          }),
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Unable to assign table");
      }

      await loadBookings();
      setAssignmentTable("");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to assign table"
      );
    }
  }

  function markGuestArrived() {
    if (!selectedBooking) {
      return;
    }

    setArrivedBookingIds((currentIds) => {
      if (currentIds.includes(selectedBooking.id)) {
        return currentIds;
      }
      return [...currentIds, selectedBooking.id];
    });
  }

  function selectBooking(booking: Booking) {
    setSelectedBookingId(booking.id);
    setAssignmentTable(String(booking.table_number));
    if (booking.reservation_date) {
      setSelectedDate(booking.reservation_date);
    }
    if (booking.reservation_time) {
      // Find closest standard hour or match
      const [h] = booking.reservation_time.split(":");
      const roundedHour = `${h.padStart(2, "0")}:00`;
      if (RESTAURANT_HOURS.includes(roundedHour)) {
        setSelectedTime(roundedHour);
      } else {
        setSelectedTime(booking.reservation_time);
      }
    }
  }

  // Countable table groupings
  const fiveSeatTables = tables.filter((t) => t.capacity === 5);
  const fourSeatTables = tables.filter((t) => t.capacity === 4);
  const twoSeatTables = tables.filter((t) => t.capacity === 2);
  const otherTables = tables.filter(
    (t) => t.capacity !== 5 && t.capacity !== 4 && t.capacity !== 2
  );

  function renderTableCard(table: DiningTable) {
    const activeBooking = bookings.find((b) => {
      if (b.status === "cancelled") return false;
      if (b.reservation_date !== selectedDate) return false;
      if (String(b.table_number) !== String(table.table_number)) return false;
      return isOverlapping(b.reservation_time, selectedTime, 60);
    });

    const isArrived =
      activeBooking &&
      (arrivedBookingIds.includes(activeBooking.id) ||
        activeBooking.status === "arrived");
    const isReserved = !!activeBooking && !isArrived;
    const isSelected =
      selectedBooking &&
      String(selectedBooking.table_number) === String(table.table_number) &&
      selectedBooking.reservation_date === selectedDate;

    return (
      <div
        className={`restaurant-table ${
          isArrived
            ? "table-arrived"
            : isReserved
            ? "table-reserved"
            : "table-available"
        } ${isSelected ? "table-selected" : ""}`}
        key={table.id}
        onClick={() => {
          if (activeBooking) {
            selectBooking(activeBooking);
          }
        }}
        style={{ cursor: activeBooking ? "pointer" : "default" }}
      >
        <div className="table-header-id">
          <strong>{table.table_number}</strong>
          <span className="table-capacity-pill">{table.capacity} seats</span>
        </div>

        <div className="table-status-pill">
          {isArrived ? "ARRIVED" : isReserved ? "RESERVED" : "AVAILABLE"}
        </div>

        {activeBooking ? (
          <div className="table-booking-meta">
            <div className="table-window-badge">
              {activeBooking.reservation_time}–{addOneHour(activeBooking.reservation_time)}
            </div>
            <div className="table-customer-name">
              #{activeBooking.id} {activeBooking.customer_name}
            </div>
          </div>
        ) : (
          <small className="table-free-indicator">Free this hour</small>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">RESTAURANT OPERATIONS</div>
          <h1>AI Booking Receptionist</h1>
          <p className="subtitle">
            Visual table representation across dates and restaurant timings.
          </p>
        </div>

        <div className="system-status">
          <span className="status-dot" />
          Backend connected
          {lastSynced && <span className="sync-time">({lastSynced})</span>}
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <main className="dashboard-grid">
        <section className="panel overview-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-label">01</span>
              <h2>Visual Restaurant Schedule</h2>
            </div>

            <span className="live-badge">1-HOUR SLOTS</span>
          </div>

          {/* 1. VISUAL DATE RIBBON (Matches screenshot) */}
          <div className="date-strip-section">
            <div className="date-strip-title">SELECT DATE:</div>
            <div className="date-ribbon-container">
              <button
                className="ribbon-arrow-btn"
                onClick={() => {
                  const [y, m, d] = selectedDate.split("-").map(Number);
                  const prev = new Date(y, m - 1, d);
                  prev.setDate(prev.getDate() - 1);
                  const iso = `${prev.getFullYear()}-${String(
                    prev.getMonth() + 1
                  ).padStart(2, "0")}-${String(prev.getDate()).padStart(2, "0")}`;
                  setSelectedDate(iso);
                }}
                type="button"
                title="Previous Day"
              >
                ‹
              </button>

              <div className="date-ribbon-scroll">
                {dateItems.map((item) => {
                  const isSelected = item.iso === selectedDate;
                  return (
                    <button
                      key={item.iso}
                      className={`date-ribbon-card ${isSelected ? "selected" : ""}`}
                      onClick={() => setSelectedDate(item.iso)}
                      type="button"
                    >
                      <span className="ribbon-day">{item.dayName}</span>
                      <span className="ribbon-num">{item.dayNum}</span>
                      <span className="ribbon-month">{item.monthName}</span>
                    </button>
                  );
                })}
              </div>

              <button
                className="ribbon-arrow-btn"
                onClick={() => {
                  const [y, m, d] = selectedDate.split("-").map(Number);
                  const next = new Date(y, m - 1, d);
                  next.setDate(next.getDate() + 1);
                  const iso = `${next.getFullYear()}-${String(
                    next.getMonth() + 1
                  ).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
                  setSelectedDate(iso);
                }}
                type="button"
                title="Next Day"
              >
                ›
              </button>
            </div>
          </div>

          {/* 2. RESTAURANT TIMINGS RIBBON */}
          <div className="restaurant-timings-card">
            <div className="timings-header">
              <span className="timings-label">
                RESTAURANT TIMINGS (1-HOUR SERVICE WINDOWS):
              </span>
              <span className="timings-sub">
                Click any hour to inspect its table layout
              </span>
            </div>

            <div className="hours-ribbon">
              {RESTAURANT_HOURS.map((hour) => {
                const isSelected = selectedTime === hour;
                const activeInHour = bookings.filter(
                  (b) =>
                    b.reservation_date === selectedDate &&
                    b.status !== "cancelled" &&
                    isOverlapping(b.reservation_time, hour, 60)
                );
                const cancelledInHour = bookings.filter(
                  (b) =>
                    b.reservation_date === selectedDate &&
                    b.status === "cancelled" &&
                    isOverlapping(b.reservation_time, hour, 60)
                );

                const isFull =
                  tables.length > 0 && activeInHour.length >= tables.length;

                return (
                  <button
                    key={hour}
                    className={`hour-slot-btn ${isSelected ? "selected" : ""} ${
                      isFull ? "full" : activeInHour.length > 0 ? "has-bookings" : "empty"
                    }`}
                    onClick={() => setSelectedTime(hour)}
                    type="button"
                  >
                    <span className="hour-time">{hour}</span>
                    <span className="hour-occupancy">
                      {activeInHour.length > 0
                        ? `${activeInHour.length} booked`
                        : "Available"}
                    </span>
                    {cancelledInHour.length > 0 && (
                      <span className="hour-cancelled-tag">
                        {cancelledInHour.length} cancelled
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. HOURLY METRICS & COMPLETE TABLE REPRESENTATION */}
          <div className="hourly-representation-card">
            <div className="representation-banner">
              <div>
                <span className="slot-badge">RESERVATION PERIOD</span>
                <h3>
                  {formatDisplayDate(selectedDate)} • {selectedTime} –{" "}
                  {addOneHour(selectedTime)}
                </h3>
              </div>

              <div className="hourly-stats-pill-group">
                <div className="stat-pill confirmed">
                  <span className="stat-label">Bookings Made</span>
                  <strong>{hourConfirmedBookings.length}</strong>
                </div>

                <div className="stat-pill cancelled">
                  <span className="stat-label">Cancelled</span>
                  <strong>{hourCancelledBookings.length}</strong>
                </div>

                <div className="stat-pill available">
                  <span className="stat-label">Available Tables</span>
                  <strong>
                    {availableTablesCount} / {tables.length}
                  </strong>
                </div>
              </div>
            </div>

            <div className="section-title">
              Complete Table Layout for this Hour
            </div>

            {tables.length === 0 ? (
              <p className="empty-text">Loading dining tables...</p>
            ) : (
              <div className="countable-tables-container">
                {/* 5-SEATER TABLES (5 Total) */}
                <div className="table-capacity-group">
                  <div className="group-header">
                    <span className="group-badge">5-SEATER TABLES (5 Total)</span>
                    <span className="group-sub">Tables T5-1 to T5-5</span>
                  </div>
                  <div className="table-grid-5">
                    {fiveSeatTables.map(renderTableCard)}
                  </div>
                </div>

                {/* 4-SEATER TABLES (4 Total) */}
                <div className="table-capacity-group">
                  <div className="group-header">
                    <span className="group-badge">4-SEATER TABLES (4 Total)</span>
                    <span className="group-sub">Tables T4-1 to T4-4</span>
                  </div>
                  <div className="table-grid-4">
                    {fourSeatTables.map(renderTableCard)}
                  </div>
                </div>

                {/* 2-SEATER TABLES (2 Total) */}
                <div className="table-capacity-group">
                  <div className="group-header">
                    <span className="group-badge">2-SEATER TABLES (2 Total)</span>
                    <span className="group-sub">Tables T2-1 to T2-2</span>
                  </div>
                  <div className="table-grid-2">
                    {twoSeatTables.map(renderTableCard)}
                  </div>
                </div>

                {/* OTHER TABLES */}
                {otherTables.length > 0 && (
                  <div className="table-capacity-group">
                    <div className="group-header">
                      <span className="group-badge">OTHER TABLES</span>
                      <span className="group-sub">Additional dining tables</span>
                    </div>
                    <div className="table-grid-4">
                      {otherTables.map(renderTableCard)}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Bookings & Cancelled list for this hour */}
            <div className="hour-bookings-panel">
              <div className="hbp-title">
                Bookings Scheduled for {selectedTime}–{addOneHour(selectedTime)} (
                {hourBookings.length} total)
              </div>

              {hourBookings.length === 0 ? (
                <div className="empty-hour-msg">
                  No bookings in this 1-hour window. All {tables.length} tables are available.
                </div>
              ) : (
                <div className="hour-booking-cards-grid">
                  {hourBookings.map((b) => (
                    <div
                      key={b.id}
                      className={`hour-booking-tile ${b.status} ${
                        selectedBookingId === b.id ? "tile-selected" : ""
                      }`}
                      onClick={() => selectBooking(b)}
                    >
                      <div className="hbt-top">
                        <strong>Booking #{b.id}</strong>
                        <span className={`status-pill ${b.status}`}>
                          {b.status}
                        </span>
                      </div>
                      <div className="hbt-name">{b.customer_name}</div>
                      <div className="hbt-meta">
                        <span>Table {b.table_number}</span>
                        <span>•</span>
                        <span>{b.guests} guests</span>
                        <span>•</span>
                        <span>{b.reservation_time}</span>
                      </div>
                      <small className="hbt-phone">{b.phone}</small>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="panel bookings-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-label">02</span>
              <h2>Agent Bookings</h2>
            </div>

            <span className="live-badge">AUTO REFRESH</span>
          </div>

          <p className="panel-description">
            All database bookings. Click any booking to inspect its date, hour, and table.
          </p>

          <div className="bookings-filter-bar">
            <button
              className={`filter-tab ${dateFilterMode === "all" ? "active" : ""}`}
              onClick={() => setDateFilterMode("all")}
              type="button"
            >
              All Bookings ({bookings.length})
            </button>
            <button
              className={`filter-tab ${
                dateFilterMode === "selected" ? "active" : ""
              }`}
              onClick={() => setDateFilterMode("selected")}
              type="button"
            >
              Only {selectedDate} (
              {bookings.filter((b) => b.reservation_date === selectedDate).length}
              )
            </button>
          </div>

          <input
            className="search-input"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search booking ID, customer, date, or table..."
          />

          {isLoading ? (
            <p className="empty-text">Loading bookings from backend...</p>
          ) : filteredBookings.length === 0 ? (
            <p className="empty-text">No bookings found for the selected filter.</p>
          ) : (
            <div className="booking-list">
              {filteredBookings.map((booking) => (
                <button
                  className={`booking-row ${
                    selectedBookingId === booking.id
                      ? "selected-booking"
                      : ""
                  }`}
                  onClick={() => selectBooking(booking)}
                  key={booking.id}
                >
                  <div className="booking-row-left">
                    <div className="booking-title-line">
                      <strong>Booking #{booking.id}</strong>
                      <span className={`status-badge-inline ${booking.status}`}>
                        {booking.status}
                      </span>
                    </div>
                    <div className="booking-customer-name">
                      {booking.customer_name}
                    </div>
                    <small className="booking-phone">{booking.phone}</small>
                    <div className="booking-date-pill">
                      📅 {booking.reservation_date}
                    </div>
                  </div>

                  <div className="booking-meta">
                    <strong className="booking-time-display">
                      {booking.reservation_time} –{" "}
                      {addOneHour(booking.reservation_time)}
                    </strong>
                    <span className="booking-slot-label">(1 hr reserved)</span>
                    <span className="booking-table-tag">
                      Table {booking.table_number}
                    </span>
                    <small className="booking-guests-tag">
                      {booking.guests} guests
                    </small>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="panel details-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-label">03</span>
              <h2>Booking Details</h2>
            </div>
          </div>

          {!selectedBooking ? (
            <div className="empty-state">
              Select a booking to view its details.
            </div>
          ) : (
            <div className="guest-details">
              <div className="guest-header">
                <div className="caller-avatar">
                  {selectedBooking.customer_name
                    .split(" ")
                    .map((part) => part[0])
                    .join("")
                    .slice(0, 2)
                    .toUpperCase()}
                </div>

                <div>
                  <h3>{selectedBooking.customer_name}</h3>
                  <p>{selectedBooking.phone}</p>
                </div>
              </div>

              <div className="detail-row">
                <span>Booking ID</span>
                <strong>#{selectedBooking.id}</strong>
              </div>

              <div className="detail-row">
                <span>Restaurant</span>
                <strong>{selectedBooking.restaurant_name}</strong>
              </div>

              <div className="detail-row">
                <span>Reservation Date</span>
                <strong className="detail-highlight-date">
                  📅 {selectedBooking.reservation_date}
                </strong>
              </div>

              <div className="detail-row">
                <span>Reservation Time</span>
                <strong>
                  {selectedBooking.reservation_time} –{" "}
                  {addOneHour(selectedBooking.reservation_time)} (1 hr)
                </strong>
              </div>

              <div className="detail-row">
                <span>Guests</span>
                <strong>{selectedBooking.guests} guests</strong>
              </div>

              <div className="detail-row">
                <span>Current Table</span>
                <strong>Table {selectedBooking.table_number}</strong>
              </div>

              <div className="detail-row">
                <span>Status</span>
                <strong>{selectedBooking.status}</strong>
              </div>

              <label>
                Reassign Table
                <select
                  value={assignmentTable}
                  onChange={(event) => setAssignmentTable(event.target.value)}
                >
                  <option value="">Select table</option>
                  {tables
                    .filter(
                      (table) => table.capacity >= selectedBooking.guests
                    )
                    .map((table) => (
                      <option
                        value={String(table.table_number)}
                        key={table.id}
                      >
                        Table {table.table_number} ({table.capacity} seats)
                      </option>
                    ))}
                </select>
              </label>

              <div className="button-row">
                <button
                  className="secondary-button"
                  onClick={assignTable}
                  type="button"
                >
                  Assign Table
                </button>

                <button
                  className="primary-button"
                  onClick={markGuestArrived}
                  type="button"
                >
                  {arrivedBookingIds.includes(selectedBooking.id)
                    ? "Guest Arrived"
                    : "Mark Arrived"}
                </button>
              </div>

              {arrivedBookingIds.includes(selectedBooking.id) && (
                <div className="arrival-confirmation">
                  Guest arrival recorded for booking #{selectedBooking.id}.
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;