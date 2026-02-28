const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'data', 'hostel.db');
const dataDir = path.dirname(dbPath);

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db = null;

// Wrapper that mimics better-sqlite3 API using sql.js
class Database {
  constructor(sqlDb) {
    this._db = sqlDb;
  }

  // Save database to file
  save() {
    const data = this._db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  }

  // Execute SQL without returning results
  exec(sql) {
    this._db.run(sql);
    this.save();
  }

  // Prepare a statement
  prepare(sql) {
    return new Statement(this._db, sql, this);
  }

  // Transaction helper
  transaction(fn) {
    return (...args) => {
      this._db.run('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        this._db.run('COMMIT');
        this.save();
        return result;
      } catch (err) {
        this._db.run('ROLLBACK');
        throw err;
      }
    };
  }
}

class Statement {
  constructor(sqlDb, sql, database) {
    this._db = sqlDb;
    this._sql = sql;
    this._database = database;
  }

  // Get a single row
  get(...params) {
    try {
      const stmt = this._db.prepare(this._sql);
      stmt.bind(params);
      if (stmt.step()) {
        const cols = stmt.getColumnNames();
        const values = stmt.get();
        const row = {};
        cols.forEach((col, i) => { row[col] = values[i]; });
        stmt.free();
        return row;
      }
      stmt.free();
      return undefined;
    } catch (err) {
      return undefined;
    }
  }

  // Get all rows
  all(...params) {
    try {
      const stmt = this._db.prepare(this._sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) {
        const cols = stmt.getColumnNames();
        const values = stmt.get();
        const row = {};
        cols.forEach((col, i) => { row[col] = values[i]; });
        rows.push(row);
      }
      stmt.free();
      return rows;
    } catch (err) {
      return [];
    }
  }

  // Run an insert/update/delete
  run(...params) {
    this._db.run(this._sql, params);
    const lastId = this._db.exec('SELECT last_insert_rowid() as id')[0];
    const changes = this._db.getRowsModified();
    this._database.save();

    return {
      lastInsertRowid: lastId ? lastId.values[0][0] : 0,
      changes: changes
    };
  }
}

// Initialize the database synchronously at module load using a blocking pattern
async function initDatabase() {
  const SQL = await initSqlJs();

  let sqlDb;
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    sqlDb = new SQL.Database(fileBuffer);
  } else {
    sqlDb = new SQL.Database();
  }

  const database = new Database(sqlDb);

  // Create tables
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT UNIQUE,
      full_name TEXT NOT NULL,
      department TEXT,
      year INTEGER,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Student' CHECK(role IN ('Student', 'Admin')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      sleep_type TEXT DEFAULT 'Early Bird' CHECK(sleep_type IN ('Early Bird', 'Night Owl', 'Flexible')),
      study_style TEXT DEFAULT 'Silent' CHECK(study_style IN ('Silent', 'Music', 'Group Study', 'Flexible')),
      noise_tolerance TEXT DEFAULT 'Medium' CHECK(noise_tolerance IN ('Low', 'Medium', 'High')),
      cleanliness_level TEXT DEFAULT 'Medium' CHECK(cleanliness_level IN ('Low', 'Medium', 'High')),
      preferred_roommate TEXT,
      conflict_list TEXT,
      is_submitted INTEGER NOT NULL DEFAULT 0,
      submitted_at DATETIME,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_number TEXT UNIQUE NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 2,
      current_occupancy INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Available' CHECK(status IN ('Available', 'Full'))
    );

    CREATE TABLE IF NOT EXISTS allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      room_id INTEGER NOT NULL,
      compatibility_score REAL DEFAULT 0,
      allocated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reallocation_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      current_room_id INTEGER,
      reason TEXT NOT NULL,
      comments TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending', 'Approved', 'Rejected')),
      admin_notes TEXT,
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (current_room_id) REFERENCES rooms(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT (datetime('now', '+30 days')),
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS archived_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_message_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL,
      message_text TEXT NOT NULL,
      created_at DATETIME NOT NULL,
      archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      reason TEXT DEFAULT 'Auto-Archived After 30 Days',
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      message TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'info' CHECK(type IN ('info', 'success', 'warning', 'error')),
      read_status INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL UNIQUE,
      total_amount REAL NOT NULL DEFAULT 50000,
      amount_paid REAL NOT NULL DEFAULT 0,
      due_date DATE DEFAULT (date('now', '+30 days')),
      status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Paid', 'Pending', 'Overdue')),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      room_id INTEGER,
      complaint_type TEXT NOT NULL,
      description TEXT NOT NULL,
      image_url TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending', 'In Review', 'Resolved', 'Rejected')),
      admin_notes TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS admin_announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      message_content TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'Normal' CHECK(priority IN ('Normal', 'Important', 'Urgent')),
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT (datetime('now', '+30 days')),
      status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active', 'Archived')),
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS global_fee_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_amount REAL,
      due_date DATE,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      order_id TEXT NOT NULL UNIQUE,
      payment_id TEXT,
      signature TEXT,
      amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Success', 'Failed', 'Pending')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS outpass_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      out_date DATE NOT NULL,
      return_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK(status IN ('Pending', 'Approved', 'Rejected')),
      admin_remark TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT (datetime('now', '+7 days')),
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS archived_outpass_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      out_date DATE NOT NULL,
      return_date DATE NOT NULL,
      status TEXT NOT NULL,
      admin_remark TEXT,
      created_at DATETIME,
      archived_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);


  // Migration: add is_submitted and submitted_at columns if missing on existing DB
  try {
    const cols = database.prepare("PRAGMA table_info(preferences)").all();
    const hasIsSubmitted = cols.some(c => c.name === 'is_submitted');
    if (!hasIsSubmitted) {
      database.exec("ALTER TABLE preferences ADD COLUMN is_submitted INTEGER NOT NULL DEFAULT 0");
      database.exec("ALTER TABLE preferences ADD COLUMN submitted_at DATETIME");
      // Backfill: mark all existing preference records as already submitted
      database.exec("UPDATE preferences SET is_submitted = 1, submitted_at = last_updated");
    }
  } catch (migrationErr) {
    console.error('[Migration] preferences is_submitted:', migrationErr.message);
  }

  db = database;
  return database;
}

// Export a function that returns the db, and the init promise
const dbReady = initDatabase();

function archiveExpiredMessages(db) {
  try {
    const expired = db.prepare("SELECT * FROM messages WHERE expires_at < datetime('now')").all();
    if (expired.length === 0) return 0;

    const insertStmt = db.prepare(`
      INSERT INTO archived_messages 
      (original_message_id, sender_id, room_id, message_text, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const deleteStmt = db.prepare("DELETE FROM messages WHERE id = ?");

    for (const msg of expired) {
      insertStmt.run(msg.id, msg.sender_id, msg.room_id, msg.message_text, msg.created_at, msg.expires_at);
      deleteStmt.run(msg.id);
    }

    return expired.length;
  } catch (err) {
    console.error('[Archiver Error]', err);
    throw err;
  }
}

function deleteExpiredAnnouncements(database) {
  try {
    // Check if expires_at column exists
    const columns = database._db.exec("PRAGMA table_info(admin_announcements)");
    const hasExpiresAt = columns.length > 0 && columns[0].values.some(col => col[1] === 'expires_at');

    if (!hasExpiresAt) {
      // sql.js doesn't support ALTER TABLE ADD COLUMN reliably
      // Recreate table with new schema, preserving existing data
      database._db.exec(`
        CREATE TABLE IF NOT EXISTS admin_announcements_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          message_content TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'Normal' CHECK(priority IN ('Normal', 'Important', 'Urgent')),
          created_by INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME DEFAULT (datetime('now', '+30 days')),
          status TEXT NOT NULL DEFAULT 'Active' CHECK(status IN ('Active', 'Archived')),
          FOREIGN KEY (created_by) REFERENCES users(id)
        )
      `);
      // Migrate existing data with computed expires_at
      database._db.exec(`
        INSERT INTO admin_announcements_new (id, title, message_content, priority, created_by, created_at, expires_at, status)
        SELECT id, title, message_content, priority, created_by, created_at, datetime(created_at, '+30 days'), status
        FROM admin_announcements
      `);
      database._db.exec("DROP TABLE admin_announcements");
      database._db.exec("ALTER TABLE admin_announcements_new RENAME TO admin_announcements");
      database.save();
    }

    // Hard-delete expired announcements
    const result = database.prepare("DELETE FROM admin_announcements WHERE datetime(expires_at) <= datetime('now')").run();
    database.save();
    return result.changes;
  } catch (err) {
    console.error('[Announcement Cleanup Error]', err);
    return 0;
  }
}

function archiveExpiredOutpasses(database) {
  try {
    const expired = database.prepare("SELECT * FROM outpass_requests WHERE datetime(expires_at) <= datetime('now')").all();
    if (expired.length === 0) return 0;

    const insertStmt = database.prepare(`
      INSERT INTO archived_outpass_requests
      (student_id, reason, out_date, return_date, status, admin_remark, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const deleteStmt = database.prepare('DELETE FROM outpass_requests WHERE id = ?');

    for (const req of expired) {
      insertStmt.run(req.student_id, req.reason, req.out_date, req.return_date, req.status, req.admin_remark, req.created_at);
      deleteStmt.run(req.id);
    }
    database.save();
    return expired.length;
  } catch (err) {
    console.error('[Outpass Archiver Error]', err);
    return 0;
  }
}

module.exports = {
  getDb: () => db,
  dbReady,
  archiveExpiredMessages,
  deleteExpiredAnnouncements,
  archiveExpiredOutpasses
};
