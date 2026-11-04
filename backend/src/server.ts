import express, {
  Request,
  Response,
  NextFunction,
} from "express";
import cors from "cors";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;

// --------------------------------------------------
// Middleware
// --------------------------------------------------

app.use(cors());
app.use(express.json());

// --------------------------------------------------
// Database setup
// --------------------------------------------------

const dataDirectory = path.join(__dirname, "../data");

if (!fs.existsSync(dataDirectory)) {
  fs.mkdirSync(dataDirectory, { recursive: true });
}

const databasePath = path.join(dataDirectory, "booking.db");

const db = new Database(databasePath);

db.pragma("foreign_keys = ON");

// --------------------------------------------------
// Database tables
// --------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS restaurants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT
  );

  CREATE TABLE IF NOT EXISTS dining_tables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    table_number TEXT NOT NULL,
    capacity INTEGER NOT NULL,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id)
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    restaurant_id INTEGER NOT NULL,
    table_id INTEGER NOT NULL,
    customer_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    reservation_date TEXT NOT NULL,
    reservation_time TEXT NOT NULL,
    guests INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (restaurant_id) REFERENCES restaurants(id),
    FOREIGN KEY (table_id) REFERENCES dining_tables(id)
  );
`);

// --------------------------------------------------
// Seed demo restaurant
// --------------------------------------------------

const restaurantCount = db
  .prepare("SELECT COUNT(*) AS count FROM restaurants")
  .get() as { count: number };

if (restaurantCount.count === 0) {
  db.prepare(`
    INSERT INTO restaurants (name, address, phone)
    VALUES (?, ?, ?)
  `).run(
    "Demo Restaurant",
    "Hyderabad, Telangana",
    "9876543210"
  );
}

// --------------------------------------------------
// Ensure Countable Dining Tables
// 2-seaters: 2 tables (T2-1, T2-2)
// 4-seaters: 4 tables (T4-1, T4-2, T4-3, T4-4)
// 5-seaters: 5 tables (T5-1, T5-2, T5-3, T5-4, T5-5)
// Total = 11 fixed countable tables
// --------------------------------------------------

function ensureCountableTables() {
  const desiredTables = [
    { table_number: "T2-1", capacity: 2 },
    { table_number: "T2-2", capacity: 2 },
    { table_number: "T4-1", capacity: 4 },
    { table_number: "T4-2", capacity: 4 },
    { table_number: "T4-3", capacity: 4 },
    { table_number: "T4-4", capacity: 4 },
    { table_number: "T5-1", capacity: 5 },
    { table_number: "T5-2", capacity: 5 },
    { table_number: "T5-3", capacity: 5 },
    { table_number: "T5-4", capacity: 5 },
    { table_number: "T5-5", capacity: 5 },
  ];

  const currentTables = db
    .prepare("SELECT id, table_number, capacity FROM dining_tables WHERE restaurant_id = 1")
    .all() as { id: number; table_number: string; capacity: number }[];

  const oldRenameMap: Record<string, { table_number: string; capacity: number }> = {
    T1: { table_number: "T2-1", capacity: 2 },
    T2: { table_number: "T2-2", capacity: 2 },
    T3: { table_number: "T4-1", capacity: 4 },
    T4: { table_number: "T4-2", capacity: 4 },
    T5: { table_number: "T5-1", capacity: 5 },
  };

  // Migrate legacy table numbers to retain foreign key references in existing bookings
  for (const oldT of currentTables) {
    if (oldRenameMap[oldT.table_number]) {
      const target = oldRenameMap[oldT.table_number];
      db.prepare(
        "UPDATE dining_tables SET table_number = ?, capacity = ? WHERE id = ?"
      ).run(target.table_number, target.capacity, oldT.id);
    }
  }

  // Insert any missing desired tables
  const insertStmt = db.prepare(
    "INSERT INTO dining_tables (restaurant_id, table_number, capacity) VALUES (1, ?, ?)"
  );

  for (const t of desiredTables) {
    const exists = db
      .prepare(
        "SELECT id FROM dining_tables WHERE restaurant_id = 1 AND table_number = ?"
      )
      .get(t.table_number);
    if (!exists) {
      insertStmt.run(t.table_number, t.capacity);
    }
  }
}

ensureCountableTables();

// --------------------------------------------------
// Helper functions
// --------------------------------------------------

function isValidDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date);
}

function isValidTime(time: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(time);
}

function isValidGuests(guests: unknown): boolean {
  return (
    typeof guests === "number" &&
    Number.isInteger(guests) &&
    guests > 0 &&
    guests <= 50
  );
}

function timeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return h * 60 + m;
}

function isTimeWindowOverlapping(
  timeA: string,
  timeB: string,
  durationMinutes = 60
): boolean {
  return Math.abs(timeToMinutes(timeA) - timeToMinutes(timeB)) < durationMinutes;
}

function getRestaurant(restaurantId: number) {
  return db
    .prepare(`
      SELECT *
      FROM restaurants
      WHERE id = ?
    `)
    .get(restaurantId) as any;
}

function getAvailableTables(
  restaurantId: number,
  date: string,
  time: string,
  guests: number,
  excludeBookingId?: number
) {
  // 1. Get all tables that meet or exceed guest capacity
  const tables = db
    .prepare(`
      SELECT
        dt.id,
        dt.restaurant_id,
        dt.table_number,
        dt.capacity
      FROM dining_tables dt
      WHERE dt.restaurant_id = ?
        AND dt.capacity >= ?
      ORDER BY dt.capacity ASC, dt.table_number ASC
    `)
    .all(restaurantId, guests) as any[];

  // 2. Query active bookings on this exact date
  let activeBookingsQuery = `
    SELECT id, table_id, reservation_time
    FROM bookings
    WHERE restaurant_id = ?
      AND reservation_date = ?
      AND status IN ('confirmed', 'arrived')
  `;
  const params: any[] = [restaurantId, date];
  if (excludeBookingId !== undefined && excludeBookingId > 0) {
    activeBookingsQuery += " AND id != ?";
    params.push(excludeBookingId);
  }

  const activeBookings = db.prepare(activeBookingsQuery).all(...params) as any[];

  // 3. Mark tables that overlap within the 60-minute window
  const busyTableIds = new Set<number>();
  for (const b of activeBookings) {
    if (isTimeWindowOverlapping(b.reservation_time, time, 60)) {
      busyTableIds.add(b.table_id);
    }
  }

  // 4. Return available tables
  return tables.filter((table) => !busyTableIds.has(table.id));
}

function getBookingById(bookingId: number) {
  return db
    .prepare(`
      SELECT
        b.id,
        b.restaurant_id,
        r.name AS restaurant_name,
        b.table_id,
        dt.table_number,
        dt.capacity,
        b.customer_name,
        b.phone,
        b.reservation_date,
        b.reservation_time,
        b.guests,
        b.status,
        b.created_at
      FROM bookings b
      JOIN restaurants r
        ON r.id = b.restaurant_id
      JOIN dining_tables dt
        ON dt.id = b.table_id
      WHERE b.id = ?
    `)
    .get(bookingId) as any;
}

function sendError(
  res: Response,
  statusCode: number,
  message: string
) {
  return res.status(statusCode).json({
    error: message,
  });
}

// --------------------------------------------------
// Root route
// --------------------------------------------------

app.get("/", (_req: Request, res: Response) => {
  res.json({
    message: "AI Booking Receptionist backend is running",
    status: "online",
    port: PORT,
  });
});

// --------------------------------------------------
// Get all restaurants
// --------------------------------------------------

app.get(
  "/api/restaurants",
  (_req: Request, res: Response) => {
    const restaurants = db
      .prepare(`
        SELECT *
        FROM restaurants
        ORDER BY id ASC
      `)
      .all();

    res.json(restaurants);
  }
);

// --------------------------------------------------
// Get all tables
// --------------------------------------------------

app.get(
  "/api/tables",
  (req: Request, res: Response) => {
    const restaurantId = Number(req.query.restaurantId || 1);

    if (!Number.isInteger(restaurantId) || restaurantId <= 0) {
      return sendError(
        res,
        400,
        "Invalid restaurantId"
      );
    }

    const tables = db
      .prepare(`
        SELECT
          id,
          restaurant_id,
          table_number,
          capacity
        FROM dining_tables
        WHERE restaurant_id = ?
        ORDER BY id ASC
      `)
      .all(restaurantId);

    res.json(tables);
  }
);

// --------------------------------------------------
// Check availability
// --------------------------------------------------

app.get(
  "/api/bookings/availability",
  (req: Request, res: Response) => {
    const restaurantId = Number(
      req.query.restaurantId || 1
    );

    const date = String(req.query.date || "");
    const time = String(req.query.time || "");
    const guests = Number(req.query.guests || 0);

    if (
      !Number.isInteger(restaurantId) ||
      restaurantId <= 0
    ) {
      return sendError(
        res,
        400,
        "Invalid restaurantId"
      );
    }

    if (!isValidDate(date)) {
      return sendError(
        res,
        400,
        "Date must use YYYY-MM-DD format"
      );
    }

    if (!isValidTime(time)) {
      return sendError(
        res,
        400,
        "Time must use HH:MM format"
      );
    }

    if (!isValidGuests(guests)) {
      return sendError(
        res,
        400,
        "Guests must be a positive number"
      );
    }

    const restaurant = getRestaurant(restaurantId);

    if (!restaurant) {
      return sendError(
        res,
        404,
        "Restaurant not found"
      );
    }

    const availableTables = getAvailableTables(
      restaurantId,
      date,
      time,
      guests
    );

    const isAvailable = availableTables.length > 0;

    res.json({
      restaurantId,
      date,
      time,
      guests,
      available: isAvailable,
      availableTables,
      message: isAvailable
        ? undefined
        : `Table unavailable for seating ${guests}`,
    });
  }
);

// --------------------------------------------------
// Create booking
// --------------------------------------------------

app.post(
  "/api/bookings",
  (req: Request, res: Response) => {
    const {
      restaurantId = 1,
      tableNumber,
      name,
      phone,
      date,
      time,
      guests,
    } = req.body;

    const numericRestaurantId = Number(restaurantId);
    const numericGuests = Number(guests);

    if (
      !Number.isInteger(numericRestaurantId) ||
      numericRestaurantId <= 0
    ) {
      return sendError(
        res,
        400,
        "Invalid restaurantId"
      );
    }

    if (
      typeof name !== "string" ||
      name.trim().length === 0
    ) {
      return sendError(
        res,
        400,
        "Customer name is required"
      );
    }

    if (
      typeof phone !== "string" ||
      phone.trim().length === 0
    ) {
      return sendError(
        res,
        400,
        "Phone number is required"
      );
    }

    if (!isValidDate(String(date))) {
      return sendError(
        res,
        400,
        "Date must use YYYY-MM-DD format"
      );
    }

    if (!isValidTime(String(time))) {
      return sendError(
        res,
        400,
        "Time must use HH:MM format"
      );
    }

    if (!isValidGuests(numericGuests)) {
      return sendError(
        res,
        400,
        "Guests must be a positive number"
      );
    }

    const restaurant = getRestaurant(
      numericRestaurantId
    );

    if (!restaurant) {
      return sendError(
        res,
        404,
        "Restaurant not found"
      );
    }

    let selectedTable: any = null;

    if (tableNumber) {
      selectedTable = db
        .prepare(`
          SELECT *
          FROM dining_tables
          WHERE restaurant_id = ?
            AND table_number = ?
            AND capacity >= ?
        `)
        .get(
          numericRestaurantId,
          String(tableNumber),
          numericGuests
        ) as any;

      if (!selectedTable) {
        return sendError(
          res,
          400,
          `Requested table does not exist or cannot fit ${numericGuests} guests`
        );
      }

      // Check 1-hour window conflicts on this date for this table
      const activeBookings = db
        .prepare(`
          SELECT id, reservation_time
          FROM bookings
          WHERE restaurant_id = ?
            AND table_id = ?
            AND reservation_date = ?
            AND status IN ('confirmed', 'arrived')
        `)
        .all(
          numericRestaurantId,
          selectedTable.id,
          String(date)
        ) as any[];

      const hasConflict = activeBookings.some((b) =>
        isTimeWindowOverlapping(b.reservation_time, String(time), 60)
      );

      if (hasConflict) {
        return sendError(
          res,
          409,
          `Table unavailable for seating ${numericGuests}`
        );
      }
    } else {
      const availableTables = getAvailableTables(
        numericRestaurantId,
        String(date),
        String(time),
        numericGuests
      );

      if (availableTables.length === 0) {
        return sendError(
          res,
          409,
          `Table unavailable for seating ${numericGuests}`
        );
      }

      selectedTable = availableTables[0];
    }

    const insertBooking = db.prepare(`
      INSERT INTO bookings (
        restaurant_id,
        table_id,
        customer_name,
        phone,
        reservation_date,
        reservation_time,
        guests,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed')
    `);

    const result = insertBooking.run(
      numericRestaurantId,
      selectedTable.id,
      name.trim(),
      phone.trim(),
      String(date),
      String(time),
      numericGuests
    );

    const bookingId = Number(result.lastInsertRowid);
    const booking = getBookingById(bookingId);

    res.status(201).json({
      message: "Booking created successfully",
      booking,
    });
  }
);

// --------------------------------------------------
// Get all bookings
// --------------------------------------------------

app.get(
  "/api/bookings",
  (req: Request, res: Response) => {
    const { date } = req.query;

    let query = `
      SELECT
        b.id,
        b.restaurant_id,
        r.name AS restaurant_name,
        b.table_id,
        dt.table_number,
        dt.capacity AS table_capacity,
        b.customer_name,
        b.phone,
        b.reservation_date,
        b.reservation_time,
        b.guests,
        b.status,
        b.created_at
      FROM bookings b
      JOIN restaurants r
        ON r.id = b.restaurant_id
      JOIN dining_tables dt
        ON dt.id = b.table_id
    `;

    const params: any[] = [];
    if (typeof date === "string" && isValidDate(date)) {
      query += " WHERE b.reservation_date = ?";
      params.push(date);
    }

    query += " ORDER BY b.reservation_date DESC, b.reservation_time DESC, b.id DESC";

    const bookings = db.prepare(query).all(...params);
    res.json(bookings);
  }
);

// --------------------------------------------------
// Get booking by ID
// --------------------------------------------------

app.get(
  "/api/bookings/:id",
  (req: Request, res: Response) => {
    const bookingId = Number(req.params.id);

    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return sendError(
        res,
        400,
        "Invalid booking ID"
      );
    }

    const booking = getBookingById(bookingId);

    if (!booking) {
      return sendError(
        res,
        404,
        "Booking not found"
      );
    }

    res.json(booking);
  }
);

// --------------------------------------------------
// Modify booking
// --------------------------------------------------

app.patch(
  "/api/bookings/:id",
  (req: Request, res: Response) => {
    const bookingId = Number(req.params.id);

    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return sendError(
        res,
        400,
        "Invalid booking ID"
      );
    }

    const existingBooking = getBookingById(bookingId);

    if (!existingBooking) {
      return sendError(
        res,
        404,
        "Booking not found"
      );
    }

    if (existingBooking.status === "cancelled") {
      return sendError(
        res,
        400,
        "Cancelled bookings cannot be modified"
      );
    }

    const {
      name,
      phone,
      date,
      time,
      guests,
      tableNumber,
    } = req.body;

    const updatedName =
      name !== undefined
        ? String(name).trim()
        : existingBooking.customer_name;

    const updatedPhone =
      phone !== undefined
        ? String(phone).trim()
        : existingBooking.phone;

    const updatedDate =
      date !== undefined
        ? String(date)
        : existingBooking.reservation_date;

    const updatedTime =
      time !== undefined
        ? String(time)
        : existingBooking.reservation_time;

    const updatedGuests =
      guests !== undefined
        ? Number(guests)
        : existingBooking.guests;

    if (updatedName.length === 0) {
      return sendError(
        res,
        400,
        "Customer name cannot be empty"
      );
    }

    if (updatedPhone.length === 0) {
      return sendError(
        res,
        400,
        "Phone number cannot be empty"
      );
    }

    if (!isValidDate(updatedDate)) {
      return sendError(
        res,
        400,
        "Date must use YYYY-MM-DD format"
      );
    }

    if (!isValidTime(updatedTime)) {
      return sendError(
        res,
        400,
        "Time must use HH:MM format"
      );
    }

    if (!isValidGuests(updatedGuests)) {
      return sendError(
        res,
        400,
        "Guests must be a positive number"
      );
    }

    let selectedTable: any = null;

    if (tableNumber !== undefined) {
      selectedTable = db
        .prepare(`
          SELECT *
          FROM dining_tables
          WHERE restaurant_id = ?
            AND table_number = ?
            AND capacity >= ?
        `)
        .get(
          existingBooking.restaurant_id,
          String(tableNumber),
          updatedGuests
        ) as any;
    } else {
      selectedTable = db
        .prepare(`
          SELECT *
          FROM dining_tables
          WHERE id = ?
            AND capacity >= ?
        `)
        .get(
          existingBooking.table_id,
          updatedGuests
        ) as any;
    }

    if (!selectedTable) {
      const availableTables = getAvailableTables(
        existingBooking.restaurant_id,
        updatedDate,
        updatedTime,
        updatedGuests,
        bookingId
      );

      if (availableTables.length === 0) {
        return sendError(
          res,
          409,
          `Table unavailable for seating ${updatedGuests}`
        );
      }

      selectedTable = availableTables[0];
    }

    const activeBookingsOnTable = db
      .prepare(`
        SELECT id, reservation_time
        FROM bookings
        WHERE restaurant_id = ?
          AND table_id = ?
          AND reservation_date = ?
          AND status IN ('confirmed', 'arrived')
          AND id != ?
      `)
      .all(
        existingBooking.restaurant_id,
        selectedTable.id,
        updatedDate,
        bookingId
      ) as any[];

    const hasConflict = activeBookingsOnTable.some((b) =>
      isTimeWindowOverlapping(b.reservation_time, updatedTime, 60)
    );

    if (hasConflict) {
      return sendError(
        res,
        409,
        `Table unavailable for seating ${updatedGuests}`
      );
    }

    db.prepare(`
      UPDATE bookings
      SET
        table_id = ?,
        customer_name = ?,
        phone = ?,
        reservation_date = ?,
        reservation_time = ?,
        guests = ?
      WHERE id = ?
    `).run(
      selectedTable.id,
      updatedName,
      updatedPhone,
      updatedDate,
      updatedTime,
      updatedGuests,
      bookingId
    );

    const updatedBooking = getBookingById(bookingId);

    res.json({
      message: "Booking updated successfully",
      booking: updatedBooking,
    });
  }
);

// --------------------------------------------------
// Cancel booking
// --------------------------------------------------

app.delete(
  "/api/bookings/:id",
  (req: Request, res: Response) => {
    const bookingId = Number(req.params.id);

    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return sendError(
        res,
        400,
        "Invalid booking ID"
      );
    }

    const existingBooking = getBookingById(bookingId);

    if (!existingBooking) {
      return sendError(
        res,
        404,
        "Booking not found"
      );
    }

    if (existingBooking.status === "cancelled") {
      return sendError(
        res,
        400,
        "Booking is already cancelled"
      );
    }

    db.prepare(`
      UPDATE bookings
      SET status = 'cancelled'
      WHERE id = ?
    `).run(bookingId);

    res.json({
      message: "Booking cancelled successfully",
      bookingId,
      status: "cancelled",
    });
  }
);

// --------------------------------------------------
// Error handler
// --------------------------------------------------

app.use(
  (
    error: Error,
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    console.error(error);

    res.status(500).json({
      error: "Internal server error",
    });
  }
);

// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(PORT, () => {
  console.log(
    `Server running at http://localhost:${PORT}`
  );
});