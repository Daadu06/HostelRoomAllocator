const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireStudent } = require('../middleware/auth');
const { calculateCompatibility } = require('../engine/compatibility');
const Razorpay = require('razorpay');
const crypto = require('crypto');

// ══════════════════════════════════════════════════════════
//  MIDDLEWARE: Clean expired messages on every request
//  (Moved to background worker in start.js)
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
//  STUDENT DASHBOARD
// ══════════════════════════════════════════════════════════
router.get('/dashboard', requireStudent, (req, res) => {
  const userId = req.session.userId;
  const db = getDb();

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const preferences = db.prepare('SELECT * FROM preferences WHERE user_id = ?').get(userId);

  const allocation = db.prepare(`
    SELECT a.*, r.room_number, r.capacity, r.current_occupancy
    FROM allocations a JOIN rooms r ON a.room_id = r.id
    WHERE a.user_id = ?
  `).get(userId);

  // Roommates
  let roommates = [];
  if (allocation) {
    const rawRoommates = db.prepare(`
      SELECT u.id, u.student_id, u.full_name, u.department, u.year, u.email,
             p.sleep_type, p.study_style, p.noise_tolerance, p.cleanliness_level,
             p.preferred_roommate, p.conflict_list
      FROM allocations a JOIN users u ON a.user_id = u.id
      LEFT JOIN preferences p ON u.id = p.user_id
      WHERE a.room_id = ? AND a.user_id != ?
    `).all(allocation.room_id, userId);

    const me = db.prepare(`
      SELECT u.id, u.student_id, u.department,
             p.sleep_type, p.study_style, p.preferred_roommate, p.conflict_list
      FROM users u LEFT JOIN preferences p ON u.id = p.user_id
      WHERE u.id = ?
    `).get(userId);

    for (const mate of rawRoommates) {
      const score = calculateCompatibility(me, {
        id: mate.id, student_id: mate.student_id, department: mate.department,
        sleep_type: mate.sleep_type, study_style: mate.study_style,
        preferred_roommate: mate.preferred_roommate, conflict_list: mate.conflict_list
      });
      roommates.push({ ...mate, score, percentage: Math.round(Math.max(0, Math.min(100, ((score + 10) / 22) * 100))) });
    }
  }

  // Reallocation request
  const activeRequest = db.prepare(`
    SELECT rr.*, r.room_number FROM reallocation_requests rr
    LEFT JOIN rooms r ON rr.current_room_id = r.id
    WHERE rr.user_id = ? ORDER BY rr.requested_at DESC LIMIT 1
  `).get(userId);

  // Timeline
  const timeline = buildTimeline(db, userId, preferences, allocation);

  // Messages
  const messages = allocation ? db.prepare(`
    SELECT m.*, u.full_name as sender_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.room_id = ? AND m.expires_at > datetime('now')
    ORDER BY m.created_at DESC LIMIT 50
  `).all(allocation.room_id).map(m => ({ ...m, formatted_time: formatIST(m.created_at) })) : [];

  // Notifications
  const notifications = db.prepare(`
    SELECT * FROM notifications WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 20
  `).all(userId);
  const unreadCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read_status = 0
  `).get(userId).cnt;

  // Fee
  const fee = db.prepare('SELECT * FROM fees WHERE user_id = ?').get(userId);

  // Complaints
  const complaints = db.prepare(`
    SELECT c.*, r.room_number FROM complaints c
    LEFT JOIN rooms r ON c.room_id = r.id
    WHERE c.user_id = ? ORDER BY c.submitted_at DESC
  `).all(userId);

  // Admin Announcements (only show announcements created after student registered)
  const announcements = db.prepare(`
    SELECT a.*, admin.full_name as admin_name
    FROM admin_announcements a
    LEFT JOIN users admin ON a.created_by = admin.id
    WHERE a.status = 'Active' AND a.created_at >= ? AND datetime(a.expires_at) > datetime('now')
    ORDER BY a.created_at DESC
  `).all(user.created_at);

  // Outpass Requests (only active, not expired)
  const outpassRequests = db.prepare(`
    SELECT * FROM outpass_requests
    WHERE student_id = ? AND datetime(expires_at) > datetime('now')
    ORDER BY created_at DESC
  `).all(userId);

  res.render('student-dashboard', {
    user, preferences, allocation, roommates,
    activeRequest: activeRequest || null,
    timeline, messages, notifications, unreadCount,
    fee: fee || null, complaints, announcements, outpassRequests,
    activePage: 'dashboard',
    success: req.query.success || null,
    error: req.query.error || null
  });
});

// ══════════════════════════════════════════════════════════
function formatIST(dateString) {
  if (!dateString) return '';
  const dt = new Date(dateString + 'Z'); // Convert SQLite UTC string to local UTC Date object
  return dt.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).toUpperCase();
}

function buildTimeline(db, userId, preferences, allocation) {
  const steps = [];
  const user = db.prepare('SELECT created_at FROM users WHERE id = ?').get(userId);
  steps.push({ label: 'Account Created', icon: 'user', done: true, date: user ? user.created_at : null });
  steps.push({ label: 'Preferences Submitted', icon: 'settings', done: !!(preferences && preferences.sleep_type), date: preferences ? preferences.last_updated : null });
  const allocationExists = db.prepare('SELECT COUNT(*) as cnt FROM allocations').get();
  const systemAllocated = allocationExists && allocationExists.cnt > 0;
  steps.push({ label: 'Allocation Run', icon: 'zap', done: systemAllocated, date: systemAllocated ? (allocation ? allocation.allocated_at : 'Completed') : null });
  steps.push({ label: 'Room Assigned', icon: 'home', done: !!allocation, date: allocation ? allocation.allocated_at : null });
  steps.push({ label: 'Move-In Ready', icon: 'check-circle', done: !!allocation, date: allocation ? allocation.allocated_at : null });
  return steps;
}

// ══════════════════════════════════════════════════════════
//  PROFILE & PREFERENCES
// ══════════════════════════════════════════════════════════
router.post('/profile', requireStudent, (req, res) => {
  const { year, email } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET year = ?, email = ? WHERE id = ?')
    .run(parseInt(year), email, req.session.userId);
  res.redirect('/student/dashboard');
});

router.post('/preferences', requireStudent, (req, res) => {
  const userId = req.session.userId;
  const db = getDb();
  const { sleep_type, study_style, noise_tolerance, cleanliness_level, preferred_roommate, conflict_list } = req.body;

  // Block re-submission if already submitted
  const existing = db.prepare('SELECT id, is_submitted FROM preferences WHERE user_id = ?').get(userId);
  if (existing && existing.is_submitted === 1) {
    return res.redirect('/student/dashboard?error=Preferences are already locked after submission');
  }

  if (existing) {
    db.prepare(`UPDATE preferences SET sleep_type=?, study_style=?, noise_tolerance=?, cleanliness_level=?,
      preferred_roommate=?, conflict_list=?, is_submitted=1, submitted_at=CURRENT_TIMESTAMP, last_updated=CURRENT_TIMESTAMP WHERE user_id=?`)
      .run(sleep_type, study_style, noise_tolerance, cleanliness_level, preferred_roommate || null, conflict_list || null, userId);
  } else {
    db.prepare(`INSERT INTO preferences (user_id, sleep_type, study_style, noise_tolerance, cleanliness_level, preferred_roommate, conflict_list, is_submitted, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)`)
      .run(userId, sleep_type, study_style, noise_tolerance, cleanliness_level, preferred_roommate || null, conflict_list || null);
  }
  res.redirect('/student/dashboard?success=Preferences saved and locked');
});

// ══════════════════════════════════════════════════════════
//  REALLOCATION REQUEST
// ══════════════════════════════════════════════════════════
router.post('/reallocation-request', requireStudent, (req, res) => {
  const userId = req.session.userId;
  const db = getDb();
  const { reason, comments } = req.body;

  const existingPending = db.prepare("SELECT id FROM reallocation_requests WHERE user_id = ? AND status = 'Pending'").get(userId);
  if (existingPending) return res.redirect('/student/dashboard?error=You already have a pending reallocation request');

  const allocation = db.prepare('SELECT room_id FROM allocations WHERE user_id = ?').get(userId);
  db.prepare('INSERT INTO reallocation_requests (user_id, current_room_id, reason, comments) VALUES (?, ?, ?, ?)')
    .run(userId, allocation ? allocation.room_id : null, reason, comments || null);

  // Notify admin
  const admin = db.prepare("SELECT id FROM users WHERE role = 'Admin' LIMIT 1").get();
  if (admin) {
    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);
    db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)')
      .run(admin.id, `New reallocation request from ${user.full_name}: ${reason}`, 'warning');
  }

  res.redirect('/student/dashboard?success=Reallocation request submitted successfully');
});

router.post('/cancel-reallocation', requireStudent, (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM reallocation_requests WHERE user_id = ? AND status = 'Pending'").run(req.session.userId);
  res.redirect('/student/dashboard?success=Reallocation request cancelled');
});

// ══════════════════════════════════════════════════════════
//  MESSAGES (Roommate Chat)
// ══════════════════════════════════════════════════════════
router.post('/send-message', requireStudent, (req, res) => {
  const userId = req.session.userId;
  const db = getDb();
  const { message_text } = req.body;

  if (!message_text || message_text.trim().length === 0 || message_text.length > 300) {
    return res.redirect('/student/dashboard?error=Message must be 1-300 characters');
  }

  const allocation = db.prepare('SELECT room_id FROM allocations WHERE user_id = ?').get(userId);
  if (!allocation) return res.redirect('/student/dashboard?error=You must be allocated a room to send messages');

  db.prepare('INSERT INTO messages (sender_id, room_id, message_text) VALUES (?, ?, ?)')
    .run(userId, allocation.room_id, message_text.trim());

  res.redirect('/student/dashboard#messages-section');
});

// Messages JSON endpoint for AJAX
router.get('/messages', requireStudent, (req, res) => {
  const userId = req.session.userId;
  const db = getDb();
  const allocation = db.prepare('SELECT room_id FROM allocations WHERE user_id = ?').get(userId);
  if (!allocation) return res.json([]);

  const messages = db.prepare(`
    SELECT m.*, u.full_name as sender_name
    FROM messages m JOIN users u ON m.sender_id = u.id
    WHERE m.room_id = ? AND m.expires_at > datetime('now')
    ORDER BY m.created_at ASC LIMIT 50
  `).all(allocation.room_id);

  res.json(messages.map(m => ({ ...m, formatted_time: formatIST(m.created_at), is_mine: m.sender_id === userId })));
});

// ══════════════════════════════════════════════════════════
//  COMPLAINTS
// ══════════════════════════════════════════════════════════
router.post('/complaint', requireStudent, (req, res) => {
  const userId = req.session.userId;
  const db = getDb();
  const { complaint_type, description } = req.body;

  if (!complaint_type || !description) {
    return res.redirect('/student/dashboard?error=Complaint type and description are required');
  }

  // Check for open complaint
  const openComplaint = db.prepare(
    "SELECT id FROM complaints WHERE user_id = ? AND status IN ('Pending', 'In Review')"
  ).get(userId);
  if (openComplaint) {
    return res.redirect('/student/dashboard?error=You already have an open complaint. Wait for resolution.');
  }

  const allocation = db.prepare('SELECT room_id FROM allocations WHERE user_id = ?').get(userId);
  db.prepare('INSERT INTO complaints (user_id, room_id, complaint_type, description) VALUES (?, ?, ?, ?)')
    .run(userId, allocation ? allocation.room_id : null, complaint_type, description);

  // Notify admin
  const admin = db.prepare("SELECT id FROM users WHERE role = 'Admin' LIMIT 1").get();
  if (admin) {
    const user = db.prepare('SELECT full_name FROM users WHERE id = ?').get(userId);
    db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)')
      .run(admin.id, `New complaint from ${user.full_name}: ${complaint_type}`, 'warning');
  }

  // Notify student
  db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)')
    .run(userId, `Your ${complaint_type} complaint has been submitted and is pending review.`, 'info');

  res.redirect('/student/dashboard?success=Complaint submitted successfully');
});

// ══════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════════════════════════
router.post('/notifications/read', requireStudent, (req, res) => {
  const db = getDb();
  db.prepare('UPDATE notifications SET read_status = 1 WHERE user_id = ?').run(req.session.userId);
  res.json({ ok: true });
});

router.get('/notifications/count', requireStudent, (req, res) => {
  const db = getDb();
  const cnt = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read_status = 0').get(req.session.userId).cnt;
  res.json({ count: cnt });
});

// ══════════════════════════════════════════════════════════
//  ALLOCATION STATUS (polling)
// ══════════════════════════════════════════════════════════
router.get('/allocation-status', requireStudent, (req, res) => {
  const db = getDb();
  const allocation = db.prepare(`
    SELECT a.*, r.room_number, r.capacity, r.current_occupancy
    FROM allocations a JOIN rooms r ON a.room_id = r.id WHERE a.user_id = ?
  `).get(req.session.userId);
  res.json({ allocated: !!allocation, allocation });
});

// ══════════════════════════════════════════════════════════
//  PAYMENTS (Razorpay)
// ══════════════════════════════════════════════════════════

// Initialize Razorpay instance
const getRazorpayInstance = () => {
  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
};

router.post('/create-order', requireStudent, async (req, res) => {
  try {
    const userId = req.session.userId;
    const db = getDb();

    // Get student fee record
    const fee = db.prepare('SELECT * FROM fees WHERE user_id = ?').get(userId);
    if (!fee) return res.status(400).json({ error: 'No fee record found' });

    const balance = fee.total_amount - fee.amount_paid;
    if (balance <= 0) return res.status(400).json({ error: 'Fee already paid' });

    const rzp = getRazorpayInstance();
    const options = {
      amount: Math.round(balance * 100), // Amount in paise
      currency: "INR",
      receipt: `receipt_${userId}_${Date.now()}`
    };

    const order = await rzp.orders.create(options);

    // Save order in database with Pending status
    db.prepare(`
      INSERT INTO payments (user_id, order_id, amount, status) 
      VALUES (?, ?, ?, 'Pending')
    `).run(userId, order.id, balance);

    res.json({ order });
  } catch (error) {
    console.error('Razorpay Error:', error);
    res.status(500).json({ error: 'Could not create order' });
  }
});

router.post('/verify-payment', requireStudent, (req, res) => {
  const userId = req.session.userId;
  const db = getDb();
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  try {
    // Generate signature using secret to verify
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body.toString())
      .digest("hex");

    const isAuthentic = expectedSignature === razorpay_signature;

    if (isAuthentic) {
      db.transaction(() => {
        // Update payment record
        db.prepare(`
          UPDATE payments SET payment_id = ?, signature = ?, status = 'Success' 
          WHERE order_id = ? AND user_id = ?
        `).run(razorpay_payment_id, razorpay_signature, razorpay_order_id, userId);

        // Update fee record
        const payment = db.prepare('SELECT amount FROM payments WHERE order_id = ?').get(razorpay_order_id);
        const fee = db.prepare('SELECT * FROM fees WHERE user_id = ?').get(userId);

        const newPaid = fee.amount_paid + payment.amount;
        const newStatus = (newPaid >= fee.total_amount) ? 'Paid' : 'Pending';

        db.prepare('UPDATE fees SET amount_paid = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?')
          .run(newPaid, newStatus, userId);

        // Notify student
        db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)')
          .run(userId, `Payment of ₹${payment.amount} received successfully. Transaction ID: ${razorpay_payment_id}`, 'success');
      })();

      res.json({ success: true, message: 'Payment verified successfully' });
    } else {
      // Failed verification
      db.prepare("UPDATE payments SET status = 'Failed' WHERE order_id = ? AND user_id = ?")
        .run(razorpay_order_id, userId);
      res.status(400).json({ success: false, error: 'Invalid signature' });
    }
  } catch (err) {
    console.error('Verification Error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});
// ══════════════════════════════════════════════════════════
//  OUTPASS REQUESTS
// ══════════════════════════════════════════════════════════
router.post('/outpass/apply', requireStudent, (req, res) => {
  const { reason, out_date, return_date } = req.body;
  const db = getDb();

  if (!reason || !reason.trim() || !out_date || !return_date) {
    return res.redirect('/student/dashboard?error=Please fill all outpass fields.');
  }
  if (new Date(return_date) <= new Date(out_date)) {
    return res.redirect('/student/dashboard?error=Return date must be after out date.');
  }

  try {
    db.prepare(`
      INSERT INTO outpass_requests (student_id, reason, out_date, return_date, expires_at)
      VALUES (?, ?, ?, ?, datetime('now', '+7 days'))
    `).run(req.session.userId, reason.trim(), out_date, return_date);
    res.redirect('/student/dashboard?success=Outpass request submitted successfully.');
  } catch (err) {
    console.error('Outpass Apply Error:', err);
    res.redirect('/student/dashboard?error=Failed to submit outpass request.');
  }
});

router.post('/outpass/cancel', requireStudent, (req, res) => {
  const { outpass_id } = req.body;
  const db = getDb();
  try {
    db.prepare("DELETE FROM outpass_requests WHERE id = ? AND student_id = ? AND status = 'Pending'")
      .run(outpass_id, req.session.userId);
    res.redirect('/student/dashboard?success=Outpass request cancelled.');
  } catch (err) {
    console.error('Outpass Cancel Error:', err);
    res.redirect('/student/dashboard?error=Failed to cancel outpass request.');
  }
});

module.exports = router;
