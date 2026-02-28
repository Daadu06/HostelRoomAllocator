/**
 * Admin Authentication Routes
 * Only allows users with role 'Admin' to log in.
 */
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');

// GET /login  — Admin login page
router.get('/login', (req, res) => {
    if (req.session.userId && req.session.role === 'Admin') {
        return res.redirect('/admin/dashboard');
    }
    res.render('admin/login', {
        error: null,
        activePage: 'login'
    });
});

// POST /login  — Admin login handler
router.post('/login', (req, res) => {
    const { email, password } = req.body;
    const db = getDb();

    if (!email || !password) {
        return res.render('admin/login', {
            error: 'Please fill in all fields',
            activePage: 'login'
        });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

    if (!user || !bcrypt.compareSync(password, user.password)) {
        return res.render('admin/login', {
            error: 'Invalid email or password',
            activePage: 'login'
        });
    }

    // Only allow Admin role
    if (user.role !== 'Admin') {
        return res.render('admin/login', {
            error: 'Access denied. This portal is for administrators only.',
            activePage: 'login'
        });
    }

    req.session.userId = user.id;
    req.session.fullName = user.full_name;
    req.session.role = user.role;
    req.session.email = user.email;

    return res.redirect('/admin/dashboard');
});

// GET /logout
router.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

module.exports = router;
