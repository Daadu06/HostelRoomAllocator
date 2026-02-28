/**
 * ── Admin Panel Server ─────────────────────────────────
 *    Runs on port 3001  |  Admin-only login + full panel
 *    Completely independent from the Student Portal.
 * ────────────────────────────────────────────────────────
 */
const express = require('express');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const { dbReady } = require('./db/database');

async function startAdminServer() {
    await dbReady;

    const app = express();
    const PORT = process.env.ADMIN_PORT || 3001;

    const FileStore = require('session-file-store')(session);

    // ── Middleware ──
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(compression());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // ── Sessions (separate store from student portal) ──
    app.use(session({
        store: new FileStore({
            path: path.join(__dirname, 'data', 'sessions-admin'),
            ttl: 86400,
            retries: 1,
            logFn: function () { }
        }),
        secret: 'hostel-admin-panel-secret-2024',
        resave: true,
        saveUninitialized: false,
        rolling: true,
        cookie: {
            maxAge: 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax'
        }
    }));

    // ── View engine ──
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // ── User locals ──
    const { addUserToLocals } = require('./middleware/auth');
    app.use(addUserToLocals);

    // ── Routes ──
    const adminAuthRoutes = require('./routes/admin-auth');
    const adminRoutes = require('./routes/admin');

    app.use('/', adminAuthRoutes);
    app.use('/admin', adminRoutes);

    // ── Root redirect ──
    app.get('/', (req, res) => {
        if (req.session.userId && req.session.role === 'Admin') {
            return res.redirect('/admin/dashboard');
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

    app.listen(PORT, () => {
        console.log(`  🛡️  Admin Panel`);
        console.log(`     http://localhost:${PORT}`);
        console.log(`     Login: admin@university.edu / admin123`);
    });
}

module.exports = startAdminServer;

// Allow running standalone
if (require.main === module) {
    startAdminServer().catch(err => {
        console.error('Failed to start Admin Panel:', err);
        process.exit(1);
    });
}
