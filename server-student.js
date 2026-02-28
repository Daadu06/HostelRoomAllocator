/**
 * ── Student Portal Server ──────────────────────────────
 *    Runs on port 3000  |  Login, Register, Dashboard
 *    Completely independent from the Admin Panel.
 * ────────────────────────────────────────────────────────
 */
const express = require('express');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const { dbReady } = require('./db/database');

async function startStudentServer() {
    await dbReady;

    const app = express();
    const PORT = process.env.STUDENT_PORT || 3000;

    const FileStore = require('session-file-store')(session);

    // ── Middleware ──
    app.use(helmet({ contentSecurityPolicy: false }));
    app.use(compression());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // ── Sessions ──
    app.use(session({
        store: new FileStore({
            path: path.join(__dirname, 'data', 'sessions-student'),
            ttl: 86400,
            retries: 1,
            logFn: function () { }
        }),
        secret: 'hostel-student-portal-secret-2024',
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

    // Add Razorpay public key to views safely
    app.use((req, res, next) => {
        res.locals.razorpayKeyId = process.env.RAZORPAY_KEY_ID;
        next();
    });

    // ── Routes ──
    const authRoutes = require('./routes/auth');
    const studentRoutes = require('./routes/student');

    app.use('/', authRoutes);
    app.use('/student', studentRoutes);

    // ── Root redirect ──
    app.get('/', (req, res) => {
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

    app.listen(PORT, () => {
        console.log(`  🎓 Student Portal`);
        console.log(`     http://localhost:${PORT}`);
        console.log(`     Login: aarav@university.edu / student123`);
    });
}

module.exports = startStudentServer;

// Allow running standalone
if (require.main === module) {
    startStudentServer().catch(err => {
        console.error('Failed to start Student Portal:', err);
        process.exit(1);
    });
}
