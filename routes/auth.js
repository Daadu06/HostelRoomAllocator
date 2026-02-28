const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

// GET /login
router.get('/login', (req, res) => {
    if (req.session.userId && req.session.role === 'Student') {
        return res.redirect('/student/dashboard');
    }
    const success = req.query.registered === 'true' ? 'Registration successful! Please sign in with your credentials.' : null;
    res.render('login', { error: null, success: success, activePage: 'login' });
});

// GET /register
router.get('/register', (req, res) => {
    if (req.session.userId && req.session.role === 'Student') {
        return res.redirect('/student/dashboard');
    }
    res.render('register', { error: null, activePage: 'register' });
});

// POST /login
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    const db = getDb();

    if (!email || !password) {
        return res.render('login', { error: 'Please fill in all fields', success: null, activePage: 'login' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.render('login', { error: 'Invalid email or password', success: null, activePage: 'login' });
    }

    // Only allow Student role on this portal
    if (user.role !== 'Student') {
        return res.render('login', {
            error: 'This portal is for students only. Admins please use the Admin Panel.',
            success: null,
            activePage: 'login'
        });
    }

    req.session.userId = user.id;
    req.session.fullName = user.full_name;
    req.session.role = user.role;
    req.session.email = user.email;

    return res.redirect('/student/dashboard');
});

// POST /register
router.post('/register', (req, res) => {
    const { student_id, full_name, department, year, email, password, confirm_password } = req.body;
    const db = getDb();

    if (!student_id || !full_name || !department || !year || !email || !password) {
        return res.render('register', { error: 'Please fill in all fields', activePage: 'register' });
    }

    if (password !== confirm_password) {
        return res.render('register', { error: 'Passwords do not match', activePage: 'register' });
    }

    if (password.length < 6) {
        return res.render('register', { error: 'Password must be at least 6 characters', activePage: 'register' });
    }

    // Check for existing user (Email)
    const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existingEmail) {
        return res.render('register', { error: 'Email address is already registered', activePage: 'register' });
    }

    // Check for existing user (Student ID)
    const existingStudentId = db.prepare('SELECT id FROM users WHERE student_id = ?').get(student_id);
    if (existingStudentId) {
        return res.render('register', { error: 'Student ID is already registered', activePage: 'register' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);

    try {
        const result = db.prepare(`
      INSERT INTO users (student_id, full_name, department, year, email, password, role)
      VALUES (?, ?, ?, ?, ?, ?, 'Student')
    `).run(student_id, full_name, department, parseInt(year), email, hashedPassword);

        // Create empty preferences
        db.prepare('INSERT INTO preferences (user_id) VALUES (?)').run(result.lastInsertRowid);

        // Only create fee record if admin has set global fee values
        let globalFee = null;
        try {
            globalFee = db.prepare('SELECT * FROM global_fee_settings WHERE id = 1').get();
        } catch (e) { }
        if (globalFee && globalFee.total_amount != null) {
            db.prepare(`
                INSERT INTO fees (user_id, total_amount, amount_paid, due_date, status)
                VALUES (?, ?, 0, ?, 'Pending')
            `).run(result.lastInsertRowid, globalFee.total_amount, globalFee.due_date);
        }

        // Redirect to login with success message (don't auto-login)
        return res.redirect('/login?registered=true');
    } catch (err) {
        console.error('Registration Error:', err);
        return res.render('register', { error: 'Registration failed: ' + err.message, activePage: 'register' });
    }
});

// GET /logout
router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

module.exports = router;
