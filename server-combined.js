/**
 * ── Combined Server for Cloud Deployment ────────────────
 *    Single port, both Student + Admin on one server.
 *    Student routes: /student/*, /login, /register
 *    Admin routes:   /admin/*,   /admin/login
 *    Works on Vercel (serverless) and traditional hosts.
 * ────────────────────────────────────────────────────────
 */
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const { getDb, dbReady, archiveExpiredMessages, deleteExpiredAnnouncements, archiveExpiredOutpasses } = require('./db/database');

const app = express();
const isVercel = process.env.VERCEL === '1';

// ── Middleware ──
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Session ──
const sessionConfig = {
    secret: 'hostel-combined-secret-2024',
    resave: true,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'lax'
    }
};

if (!isVercel) {
    const FileStore = require('session-file-store')(session);
    sessionConfig.store = new FileStore({
        path: path.join(__dirname, 'data', 'sessions'),
        ttl: 86400,
        retries: 1,
        logFn: function () { }
    });
}

app.use(session(sessionConfig));

// ── View engine ──
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── User locals ──
const { addUserToLocals } = require('./middleware/auth');
app.use(addUserToLocals);

// Add Razorpay public key to views
app.use((req, res, next) => {
    res.locals.razorpayKeyId = process.env.RAZORPAY_KEY_ID;
    next();
});

// ── Routes ──
const authRoutes = require('./routes/auth');
const studentRoutes = require('./routes/student');
const adminAuthRoutes = require('./routes/admin-auth');
const adminRoutes = require('./routes/admin');

app.use('/', authRoutes);
app.use('/admin', adminAuthRoutes);
app.use('/student', studentRoutes);
app.use('/admin', adminRoutes);

// ── Root redirect ──
app.get('/', (req, res) => {
    if (req.session.userId && req.session.role === 'Admin') {
        return res.redirect('/admin/dashboard');
    }
    if (req.session.userId && req.session.role === 'Student') {
        return res.redirect('/student/dashboard');
    }
    res.redirect('/login');
});

// ── 404 ──
app.use((req, res) => {
    res.status(404).render('error', { message: 'Page not found', activePage: '' });
});

// ── Error handler ──
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', { message: 'Something went wrong', activePage: '' });
});

// ── Start server (non-Vercel) ──
if (!isVercel) {
    dbReady.then(() => {
        const PORT = process.env.PORT || 3000;

        // Background workers
        setInterval(() => {
            try { archiveExpiredMessages(getDb()); } catch (e) { }
            try { deleteExpiredAnnouncements(getDb()); } catch (e) { }
            try { archiveExpiredOutpasses(getDb()); } catch (e) { }
        }, 1000 * 60 * 60);

        try { archiveExpiredMessages(getDb()); } catch (e) { }
        try { deleteExpiredAnnouncements(getDb()); } catch (e) { }
        try { archiveExpiredOutpasses(getDb()); } catch (e) { }

        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🏨 Smart Hostel running on port ${PORT}`);
        });
    }).catch(err => {
        console.error('Failed to start:', err);
        process.exit(1);
    });
}

// ── Export for Vercel ──
module.exports = app;
