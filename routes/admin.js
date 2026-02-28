const express = require('express');
const router = express.Router();
const { getDb } = require('../db/database');
const { requireAdmin } = require('../middleware/auth');
const { runAllocation, resetAllocations } = require('../engine/allocator');

/* ────────────────────────────────────
   HELPERS
   ──────────────────────────────────── */
function getStats(db) {
    const totalStudents = db.prepare('SELECT COUNT(*) as count FROM users WHERE role = ?').get('Student').count;
    const totalRooms = db.prepare('SELECT COUNT(*) as count FROM rooms').get().count;
    const allocatedStudents = db.prepare('SELECT COUNT(*) as count FROM allocations').get().count;
    const pendingStudents = totalStudents - allocatedStudents;
    const avgCompatibility = db.prepare('SELECT AVG(compatibility_score) as avg FROM allocations').get().avg || 0;
    const totalCapacity = db.prepare('SELECT SUM(capacity) as total FROM rooms').get().total || 0;
    const totalOccupancy = db.prepare('SELECT SUM(current_occupancy) as total FROM rooms').get().total || 0;
    const occupancyRate = totalCapacity > 0 ? Math.round((totalOccupancy / totalCapacity) * 100) : 0;
    // Extra counts for sidebar badges
    const pendingRealloc = db.prepare("SELECT COUNT(*) as cnt FROM reallocation_requests WHERE status = 'Pending'").get().cnt;
    const pendingComplaints = db.prepare("SELECT COUNT(*) as cnt FROM complaints WHERE status IN ('Pending', 'In Review')").get().cnt;
    const pendingFees = db.prepare("SELECT COUNT(*) as cnt FROM fees WHERE status IN ('Pending', 'Overdue')").get().cnt;
    const pendingOutpass = db.prepare("SELECT COUNT(*) as cnt FROM outpass_requests WHERE status = 'Pending'").get().cnt;
    return {
        totalStudents, totalRooms, allocatedStudents, pendingStudents,
        avgCompatibility: avgCompatibility.toFixed(1), occupancyRate,
        pendingRealloc, pendingComplaints, pendingFees, pendingOutpass
    };
}

function getDepartments(db) {
    return db.prepare('SELECT department, COUNT(*) as count FROM users WHERE role = ? GROUP BY department ORDER BY count DESC').all('Student');
}
function getStudents(db) {
    return db.prepare(`
        SELECT u.*, p.sleep_type, p.study_style, p.noise_tolerance, p.cleanliness_level,
               a.room_id, r.room_number,
               CASE WHEN a.id IS NOT NULL THEN 'Allocated' ELSE 'Pending' END as allocation_status
        FROM users u LEFT JOIN preferences p ON u.id = p.user_id
        LEFT JOIN allocations a ON u.id = a.user_id LEFT JOIN rooms r ON a.room_id = r.id
        WHERE u.role = 'Student' ORDER BY u.full_name
    `).all();
}
function getRooms(db) { return db.prepare('SELECT * FROM rooms ORDER BY room_number').all(); }
function getAllocations(db) {
    return db.prepare(`
        SELECT a.*, u.full_name, u.student_id, u.department, r.room_number
        FROM allocations a JOIN users u ON a.user_id = u.id JOIN rooms r ON a.room_id = r.id
        ORDER BY r.room_number, u.full_name
    `).all();
}

let systemSettings = {
    weight_sleep: 3, weight_study: 3, weight_noise: 2, weight_clean: 2,
    bonus_preferred: 5, penalty_conflict: -10
};

/* ────────────────────────────────────
   EXISTING PAGE ROUTES
   ──────────────────────────────────── */
router.get('/dashboard', requireAdmin, (req, res) => {
    const db = getDb();
    res.render('admin/dashboard', {
        stats: getStats(db), departments: getDepartments(db),
        activePage: 'dashboard', success: req.query.success || null, error: req.query.error || null
    });
});

router.get('/students', requireAdmin, (req, res) => {
    const db = getDb();
    res.render('admin/students', {
        stats: getStats(db), students: getStudents(db), departments: getDepartments(db),
        activePage: 'students', success: req.query.success || null, error: req.query.error || null
    });
});

router.get('/rooms', requireAdmin, (req, res) => {
    const db = getDb();
    res.render('admin/rooms', {
        stats: getStats(db), rooms: getRooms(db),
        activePage: 'rooms', success: req.query.success || null, error: req.query.error || null
    });
});

router.get('/allocation', requireAdmin, (req, res) => {
    const db = getDb();
    res.render('admin/allocation', {
        stats: getStats(db), allocations: getAllocations(db),
        activePage: 'allocation', success: req.query.success || null, error: req.query.error || null
    });
});

router.get('/reports', requireAdmin, (req, res) => {
    const db = getDb();
    const yearDistribution = db.prepare(
        'SELECT year, COUNT(*) as count FROM users WHERE role = ? AND year IS NOT NULL GROUP BY year ORDER BY year'
    ).all('Student');
    res.render('admin/reports', {
        stats: getStats(db), departments: getDepartments(db), rooms: getRooms(db),
        allocations: getAllocations(db), yearDistribution,
        activePage: 'reports', success: null, error: null
    });
});

router.get('/settings', requireAdmin, (req, res) => {
    const db = getDb();
    res.render('admin/settings', {
        stats: getStats(db), settings: systemSettings,
        activePage: 'settings', success: req.query.success || null, error: null
    });
});
router.post('/settings', requireAdmin, (req, res) => {
    const { weight_sleep, weight_study, weight_noise, weight_clean, bonus_preferred, penalty_conflict } = req.body;
    systemSettings = {
        weight_sleep: parseFloat(weight_sleep) || 3, weight_study: parseFloat(weight_study) || 3,
        weight_noise: parseFloat(weight_noise) || 2, weight_clean: parseFloat(weight_clean) || 2,
        bonus_preferred: parseInt(bonus_preferred) || 5, penalty_conflict: parseInt(penalty_conflict) || -10
    };
    res.redirect('/admin/settings?success=Settings saved successfully');
});

/* ────────────────────────────────────
   REALLOCATION REQUESTS PAGE
   ──────────────────────────────────── */
router.get('/reallocations', requireAdmin, (req, res) => {
    const db = getDb();
    const requests = db.prepare(`
        SELECT rr.*, u.full_name, u.student_id, u.email, r.room_number
        FROM reallocation_requests rr
        JOIN users u ON rr.user_id = u.id
        LEFT JOIN rooms r ON rr.current_room_id = r.id
        ORDER BY CASE WHEN rr.status = 'Pending' THEN 0 ELSE 1 END, rr.requested_at DESC
    `).all();
    res.render('admin/reallocations', {
        stats: getStats(db), requests,
        activePage: 'reallocations', success: req.query.success || null, error: req.query.error || null
    });
});

router.post('/reallocations/:id/approve', requireAdmin, (req, res) => {
    const db = getDb();
    const { admin_notes } = req.body;
    db.prepare("UPDATE reallocation_requests SET status = 'Approved', admin_notes = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(admin_notes || null, req.params.id);
    // Notify student
    const rr = db.prepare('SELECT user_id FROM reallocation_requests WHERE id = ?').get(req.params.id);
    if (rr) {
        db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)')
            .run(rr.user_id, 'Your reallocation request has been approved!', 'success');
    }
    res.redirect('/admin/reallocations?success=Request approved');
});

router.post('/reallocations/:id/reject', requireAdmin, (req, res) => {
    const db = getDb();
    const { admin_notes } = req.body;
    db.prepare("UPDATE reallocation_requests SET status = 'Rejected', admin_notes = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(admin_notes || null, req.params.id);
    const rr = db.prepare('SELECT user_id FROM reallocation_requests WHERE id = ?').get(req.params.id);
    if (rr) {
        db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)')
            .run(rr.user_id, 'Your reallocation request has been rejected.', 'error');
    }
    res.redirect('/admin/reallocations?success=Request rejected');
});

/* ────────────────────────────────────
   COMPLAINTS PAGE
   ──────────────────────────────────── */
router.get('/complaints', requireAdmin, (req, res) => {
    const db = getDb();
    const statusFilter = req.query.status || 'all';
    let query = `
        SELECT c.*, u.full_name, u.student_id, u.email, r.room_number
        FROM complaints c JOIN users u ON c.user_id = u.id
        LEFT JOIN rooms r ON c.room_id = r.id
    `;
    if (statusFilter !== 'all') query += ` WHERE c.status = '${statusFilter}'`;
    query += ' ORDER BY CASE WHEN c.status = \'Pending\' THEN 0 WHEN c.status = \'In Review\' THEN 1 ELSE 2 END, c.submitted_at DESC';

    const complaints = db.prepare(query).all();
    res.render('admin/complaints', {
        stats: getStats(db), complaints, statusFilter,
        activePage: 'complaints', success: req.query.success || null, error: req.query.error || null
    });
});

router.post('/complaints/:id/update', requireAdmin, (req, res) => {
    const db = getDb();
    const { status, admin_notes } = req.body;
    const resolvedAt = (status === 'Resolved' || status === 'Rejected') ? new Date().toISOString() : null;
    db.prepare('UPDATE complaints SET status = ?, admin_notes = ?, resolved_at = ? WHERE id = ?')
        .run(status, admin_notes || null, resolvedAt, req.params.id);

    const complaint = db.prepare('SELECT user_id, complaint_type FROM complaints WHERE id = ?').get(req.params.id);
    if (complaint) {
        const msg = status === 'Resolved' ? `Your ${complaint.complaint_type} complaint has been resolved.`
            : status === 'Rejected' ? `Your ${complaint.complaint_type} complaint has been rejected.`
                : `Your ${complaint.complaint_type} complaint is now under review.`;
        const type = status === 'Resolved' ? 'success' : status === 'Rejected' ? 'error' : 'info';
        db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)').run(complaint.user_id, msg, type);
    }
    res.redirect('/admin/complaints?success=Complaint updated');
});

/* ────────────────────────────────────
   FEE MANAGEMENT PAGE
   ──────────────────────────────────── */
router.get('/fees', requireAdmin, (req, res) => {
    const db = getDb();
    const feeRecords = db.prepare(`
        SELECT f.*, u.full_name, u.student_id, u.email, u.department
        FROM fees f JOIN users u ON f.user_id = u.id
        ORDER BY CASE WHEN f.status = 'Overdue' THEN 0 WHEN f.status = 'Pending' THEN 1 ELSE 2 END, u.full_name
    `).all();
    const totalCollected = db.prepare('SELECT SUM(amount_paid) as total FROM fees').get().total || 0;
    const totalDue = db.prepare('SELECT SUM(total_amount - amount_paid) as total FROM fees').get().total || 0;

    let globalFee = null;
    try {
        globalFee = db.prepare('SELECT * FROM global_fee_settings WHERE id = 1').get() || null;
    } catch (e) { }

    const paymentHistory = db.prepare(`
        SELECT p.*, u.full_name, u.student_id 
        FROM payments p JOIN users u ON p.user_id = u.id
        ORDER BY p.created_at DESC
    `).all();

    res.render('admin/fees', {
        stats: getStats(db), feeRecords, totalCollected, totalDue,
        globalFee, paymentHistory,
        activePage: 'fees', success: req.query.success || null, error: req.query.error || null
    });
});

router.post('/fees/:id/update', requireAdmin, (req, res) => {
    const db = getDb();
    const { total_amount, amount_paid, due_date, status } = req.body;
    db.prepare('UPDATE fees SET total_amount = ?, amount_paid = ?, due_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(parseFloat(total_amount), parseFloat(amount_paid), due_date, status, req.params.id);

    const fee = db.prepare('SELECT user_id FROM fees WHERE id = ?').get(req.params.id);
    if (fee) {
        db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)')
            .run(fee.user_id, `Your hostel fee status has been updated to: ${status}`, status === 'Paid' ? 'success' : 'warning');
    }
    res.redirect('/admin/fees?success=Fee record updated');
});

router.post('/fees/set-all', requireAdmin, (req, res) => {
    const db = getDb();
    const { total_amount, due_date } = req.body;
    const amount = parseFloat(total_amount);

    try {
        db.transaction(() => {
            const existingGlobal = db.prepare('SELECT id FROM global_fee_settings WHERE id = 1').get();
            if (existingGlobal) {
                db.prepare('UPDATE global_fee_settings SET total_amount = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(amount, due_date);
            } else {
                db.prepare('INSERT INTO global_fee_settings (id, total_amount, due_date) VALUES (1, ?, ?)').run(amount, due_date);
            }

            const students = db.prepare("SELECT id FROM users WHERE role = 'Student'").all();
            const checkFee = db.prepare("SELECT id FROM fees WHERE user_id = ?");
            const updateFee = db.prepare("UPDATE fees SET total_amount = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?");
            const insertFee = db.prepare("INSERT INTO fees (user_id, total_amount, amount_paid, due_date, status) VALUES (?, ?, 0, ?, 'Pending')");

            for (const student of students) {
                const hasFee = checkFee.get(student.id);
                if (hasFee) {
                    updateFee.run(amount, due_date, student.id);
                } else {
                    insertFee.run(student.id, amount, due_date);
                }
            }
        })();
        res.redirect('/admin/fees?success=All fee amounts updated and applied to all students');
    } catch (err) {
        console.error(err);
        res.redirect('/admin/fees?error=Failed to update fees');
    }
});

/* ────────────────────────────────────
   NOTIFICATIONS
   ──────────────────────────────────── */
router.get('/notifications', requireAdmin, (req, res) => {
    const db = getDb();
    const adminId = req.session.userId;
    const notifications = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(adminId);
    const unreadCount = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read_status = 0').get(adminId).cnt;
    res.render('admin/notifications', {
        stats: getStats(db), notifications, unreadCount,
        activePage: 'notifications', success: req.query.success || null, error: null
    });
});

router.post('/notifications/read', requireAdmin, (req, res) => {
    const db = getDb();
    db.prepare('UPDATE notifications SET read_status = 1 WHERE user_id = ?').run(req.session.userId);
    res.json({ ok: true });
});

router.get('/notifications/count', requireAdmin, (req, res) => {
    const db = getDb();
    const cnt = db.prepare('SELECT COUNT(*) as cnt FROM notifications WHERE user_id = ? AND read_status = 0').get(req.session.userId).cnt;
    res.json({ count: cnt });
});

/* ────────────────────────────────────
   EXISTING ACTION ROUTES
   ──────────────────────────────────── */
router.post('/rooms', requireAdmin, (req, res) => {
    const { room_number, capacity } = req.body;
    const db = getDb();
    if (!room_number || !capacity) return res.redirect('/admin/rooms?error=Room number and capacity are required');
    try {
        db.prepare('INSERT INTO rooms (room_number, capacity) VALUES (?, ?)').run(room_number, parseInt(capacity));
        res.redirect('/admin/rooms?success=Room added successfully');
    } catch (err) { res.redirect('/admin/rooms?error=Room number already exists'); }
});

router.post('/rooms/:id/edit', requireAdmin, (req, res) => {
    const { room_number, capacity } = req.body;
    const db = getDb();
    try {
        db.prepare('UPDATE rooms SET room_number = ?, capacity = ? WHERE id = ?').run(room_number, parseInt(capacity), req.params.id);
        res.redirect('/admin/rooms?success=Room updated successfully');
    } catch (err) { res.redirect('/admin/rooms?error=Failed to update room'); }
});

router.post('/rooms/:id/delete', requireAdmin, (req, res) => {
    const db = getDb();
    const hasAllocations = db.prepare('SELECT COUNT(*) as count FROM allocations WHERE room_id = ?').get(req.params.id).count;
    if (hasAllocations > 0) return res.redirect('/admin/rooms?error=Cannot delete room with active allocations');
    db.prepare('DELETE FROM rooms WHERE id = ?').run(req.params.id);
    res.redirect('/admin/rooms?success=Room deleted successfully');
});

router.post('/students/:id/delete', requireAdmin, (req, res) => {
    const db = getDb();
    const studentId = req.params.id;
    const allocation = db.prepare('SELECT room_id FROM allocations WHERE user_id = ?').get(studentId);
    if (allocation) {
        db.prepare("UPDATE rooms SET current_occupancy = current_occupancy - 1, status = 'Available' WHERE id = ?").run(allocation.room_id);
        db.prepare('DELETE FROM allocations WHERE user_id = ?').run(studentId);
    }
    db.prepare('DELETE FROM preferences WHERE user_id = ?').run(studentId);
    db.prepare('DELETE FROM users WHERE id = ? AND role = ?').run(studentId, 'Student');
    res.redirect('/admin/students?success=Student removed successfully');
});

router.post('/allocate', requireAdmin, (req, res) => {
    try {
        const result = runAllocation();
        // Notify all allocated students
        const db = getDb();
        const allocated = db.prepare('SELECT user_id FROM allocations').all();
        allocated.forEach(a => {
            const alloc = db.prepare('SELECT r.room_number FROM allocations al JOIN rooms r ON al.room_id = r.id WHERE al.user_id = ?').get(a.user_id);
            if (alloc) {
                db.prepare("INSERT INTO notifications (user_id, message, type) VALUES (?, ?, 'success')")
                    .run(a.user_id, `You have been allocated to Room ${alloc.room_number}!`);
            }
        });
        res.redirect('/admin/allocation?success=' + encodeURIComponent(`Allocation complete: ${result.allocated} allocated, ${result.skipped} skipped`));
    } catch (err) { res.redirect('/admin/allocation?error=' + encodeURIComponent('Allocation failed: ' + err.message)); }
});

router.post('/reset-allocation', requireAdmin, (req, res) => {
    try { resetAllocations(); res.redirect('/admin/allocation?success=All allocations have been reset'); }
    catch (err) { res.redirect('/admin/allocation?error=Failed to reset allocations'); }
});

router.get('/export', requireAdmin, (req, res) => {
    const db = getDb();
    const allocations = db.prepare(`
        SELECT u.student_id, u.full_name, u.department, u.year, u.email,
               r.room_number, r.capacity, a.compatibility_score, a.allocated_at
        FROM allocations a JOIN users u ON a.user_id = u.id JOIN rooms r ON a.room_id = r.id
        ORDER BY r.room_number
    `).all();
    let csv = 'Student ID,Full Name,Department,Year,Email,Room Number,Room Capacity,Compatibility Score,Allocated At\n';
    for (const a of allocations) csv += `${a.student_id},${a.full_name},${a.department},${a.year},${a.email},${a.room_number},${a.capacity},${a.compatibility_score},${a.allocated_at}\n`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=allocations_report.csv');
    res.send(csv);
});

router.get('/students/:id/preferences', requireAdmin, (req, res) => {
    const db = getDb();
    const student = db.prepare(`
        SELECT u.*, p.sleep_type, p.study_style, p.noise_tolerance, p.cleanliness_level, p.preferred_roommate, p.conflict_list
        FROM users u LEFT JOIN preferences p ON u.id = p.user_id WHERE u.id = ?
    `).get(req.params.id);
    res.json(student || {});
});

/* ────────────────────────────────────
   ROOM DETAILS ENHANCEMENT (AJAX)
   ──────────────────────────────────── */
router.get('/rooms/:id/details', requireAdmin, (req, res) => {
    const db = getDb();
    const roomId = req.params.id;
    const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const students = db.prepare(`
        SELECT u.id, u.full_name, u.student_id, u.department, u.year,
               p.sleep_type, p.study_style, a.compatibility_score,
               f.status as fee_status
        FROM allocations a
        JOIN users u ON a.user_id = u.id
        LEFT JOIN preferences p ON u.id = p.user_id
        LEFT JOIN fees f ON u.id = f.user_id
        WHERE a.room_id = ?
    `).all(roomId);
    res.json({ room, students });
});

router.post('/rooms/remove-student', requireAdmin, (req, res) => {
    const { studentId, roomId } = req.body;
    const db = getDb();
    try {
        db.prepare('DELETE FROM allocations WHERE user_id = ? AND room_id = ?').run(studentId, roomId);
        db.prepare("UPDATE rooms SET current_occupancy = current_occupancy - 1, status = 'Available' WHERE id = ?").run(roomId);
        db.prepare("INSERT INTO notifications (user_id, message, type) VALUES (?, ?, 'info')").run(studentId, 'You have been removed from your room allocation.', 'info');
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to remove student' }); }
});

router.post('/rooms/transfer-student', requireAdmin, (req, res) => {
    const { studentId, fromRoomId, toRoomId } = req.body;
    const db = getDb();
    try {
        let toRoom;
        if (isNaN(toRoomId)) {
            toRoom = db.prepare('SELECT * FROM rooms WHERE room_number = ?').get(toRoomId);
        } else {
            toRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(toRoomId);
        }

        if (!toRoom) return res.status(404).json({ error: 'Target room not found' });
        if (toRoom.current_occupancy >= toRoom.capacity) return res.status(400).json({ error: 'Target room is full' });

        db.prepare('UPDATE allocations SET room_id = ? WHERE user_id = ? AND room_id = ?').run(toRoom.id, studentId, fromRoomId);
        db.prepare("UPDATE rooms SET current_occupancy = current_occupancy - 1, status = 'Available' WHERE id = ?").run(fromRoomId);
        db.prepare("UPDATE rooms SET current_occupancy = current_occupancy + 1 WHERE id = ?").run(toRoom.id);

        const updatedToRoom = db.prepare('SELECT * FROM rooms WHERE id = ?').get(toRoom.id);
        if (updatedToRoom.current_occupancy >= updatedToRoom.capacity) {
            db.prepare("UPDATE rooms SET status = 'Full' WHERE id = ?").run(toRoom.id);
        }

        db.prepare("INSERT INTO notifications (user_id, message, type) VALUES (?, ?, 'info')").run(studentId, `You have been transferred to Room ${updatedToRoom.room_number}.`, 'info');
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to transfer student' });
    }
});

router.post('/rooms/notify-room', requireAdmin, (req, res) => {
    const { roomId, message } = req.body;
    const db = getDb();
    try {
        const students = db.prepare('SELECT user_id FROM allocations WHERE room_id = ?').all(roomId);
        const stmt = db.prepare("INSERT INTO notifications (user_id, message, type) VALUES (?, ?, 'info')");
        students.forEach(s => stmt.run(s.user_id, message));
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Failed to send notifications' }); }
});

/* ────────────────────────────────────
   SECURE MESSAGE ARCHIVAL
   ──────────────────────────────────── */
router.get('/archived-messages', requireAdmin, (req, res) => {
    // Audit Log
    console.log(`[AUDIT] Admin Access: Viewed Archived Messages at ${new Date().toISOString()}`);

    const db = getDb();
    const stats = getStats(db);
    const { search, student, room } = req.query;

    let query = `
        SELECT am.*, u.full_name as sender_name, u.student_id, r.room_number
        FROM archived_messages am
        LEFT JOIN users u ON am.sender_id = u.id
        LEFT JOIN rooms r ON am.room_id = r.id
        WHERE 1=1
    `;
    const params = [];

    // Filters
    if (search) {
        query += " AND am.message_text LIKE ?";
        params.push(`%${search}%`);
    }
    if (student) {
        query += " AND u.full_name LIKE ?";
        params.push(`%${student}%`);
    }
    if (room) {
        query += " AND r.room_number LIKE ?";
        params.push(`%${room}%`);
    }

    query += " ORDER BY am.archived_at DESC LIMIT 100";

    const archivedMessages = db.prepare(query).all(...params);

    res.render('admin/archived-messages', {
        user: req.session.user,
        activePage: 'archived-messages',
        stats,
        archivedMessages,
        filters: { search: search || '', student: student || '', room: room || '' }
    });
});
/* ────────────────────────────────────
   ADMIN ANNOUNCEMENTS
   ──────────────────────────────────── */
router.get('/announcements', requireAdmin, (req, res) => {
    const db = getDb();
    const stats = getStats(db);
    const announcements = db.prepare(`
        SELECT a.*, admin.full_name as admin_name 
        FROM admin_announcements a
        LEFT JOIN users admin ON a.created_by = admin.id
        WHERE datetime(a.expires_at) > datetime('now')
        ORDER BY a.created_at DESC
    `).all();

    res.render('admin/announcements', {
        user: req.session.user,
        activePage: 'announcements',
        stats,
        announcements,
        success: req.query.success || null,
        error: req.query.error || null
    });
});

router.post('/announcements', requireAdmin, (req, res) => {
    const { title, message_content, priority } = req.body;
    const db = getDb();

    if (!title || !title.trim() || !message_content || !message_content.trim()) {
        return res.redirect('/admin/announcements?error=Please fill all required fields.');
    }

    try {
        db.prepare(`
            INSERT INTO admin_announcements (title, message_content, priority, created_by, expires_at)
            VALUES (?, ?, ?, ?, datetime('now', '+30 days'))
        `).run(title, message_content, priority || 'Normal', req.session.userId);

        // Optionally attempt to notify students gracefully without transaction blocks
        try {
            const students = db.prepare("SELECT id FROM users WHERE role = 'Student'").all();
            const notificationMsg = `New Announcement: ${title}`;
            const stmt = db.prepare("INSERT INTO notifications (user_id, message, type) VALUES (?, ?, 'info')");
            for (const user of students) {
                try {
                    stmt.run(user.id, notificationMsg);
                } catch (e) {
                    console.error("Non-fatal notification skip for user", user.id);
                }
            }
        } catch (notifErr) {
            console.error("Non-fatal global notification skip", notifErr);
        }

        res.redirect('/admin/announcements?success=Announcement broad-casted successfully');
    } catch (error) {
        console.error("Announcement Broadcast Error:", error);
        res.redirect('/admin/announcements?error=Unable to send announcement. Please try again.');
    }
});

/* ────────────────────────────────────
   OUTPASS MANAGEMENT
   ──────────────────────────────────── */
router.get('/outpass', requireAdmin, (req, res) => {
    const db = getDb();
    const stats = getStats(db);

    const activeRequests = db.prepare(`
        SELECT o.*, u.full_name, u.student_id, u.department
        FROM outpass_requests o
        JOIN users u ON o.student_id = u.id
        WHERE datetime(o.expires_at) > datetime('now')
        ORDER BY o.created_at DESC
    `).all();

    const archivedRequests = db.prepare(`
        SELECT a.*, u.full_name, u.student_id, u.department
        FROM archived_outpass_requests a
        JOIN users u ON a.student_id = u.id
        ORDER BY a.archived_at DESC
        LIMIT 100
    `).all();

    res.render('admin/outpass', {
        user: req.session.user,
        activePage: 'outpass',
        stats,
        activeRequests,
        archivedRequests,
        success: req.query.success || null,
        error: req.query.error || null
    });
});

router.post('/outpass/:id/update', requireAdmin, (req, res) => {
    const { status, admin_remark } = req.body;
    const db = getDb();

    if (!['Approved', 'Rejected'].includes(status)) {
        return res.redirect('/admin/outpass?error=Invalid status.');
    }

    try {
        db.prepare('UPDATE outpass_requests SET status = ?, admin_remark = ? WHERE id = ?')
            .run(status, admin_remark || null, req.params.id);

        // Notify the student
        const outpass = db.prepare('SELECT student_id FROM outpass_requests WHERE id = ?').get(req.params.id);
        if (outpass) {
            db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)')
                .run(outpass.student_id, `Your outpass request has been ${status.toLowerCase()}.${admin_remark ? ' Remark: ' + admin_remark : ''}`, status === 'Approved' ? 'success' : 'error');
        }

        res.redirect(`/admin/outpass?success=Outpass ${status.toLowerCase()} successfully.`);
    } catch (err) {
        console.error('Outpass Update Error:', err);
        res.redirect('/admin/outpass?error=Failed to update outpass request.');
    }
});

module.exports = router;
