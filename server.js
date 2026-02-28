const express = require('express');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');

const { dbReady } = require('./db/database');

async function startServer() {
    // Wait for database to initialize
    await dbReady;

    const app = express();
    const PORT = process.env.PORT || 3000;

    // Session store
    const FileStore = require('session-file-store')(session);

    // Middleware
    app.use(helmet({
        contentSecurityPolicy: false
    }));
    app.use(compression());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.json());
    app.use(express.static(path.join(__dirname, 'public')));

    // Session configuration
    app.use(session({
        store: new FileStore({
            path: path.join(__dirname, 'data', 'sessions'),
            ttl: 86400,
            retries: 1,
            logFn: function () { }
        }),
        secret: 'hostel-allocation-secret-key-2024',
        resave: false,
        saveUninitialized: false,
        cookie: {
            maxAge: 24 * 60 * 60 * 1000,
            httpOnly: true,
            sameSite: 'lax'
        }
    }));

    // View engine
    app.set('view engine', 'ejs');
    app.set('views', path.join(__dirname, 'views'));

    // Add user info to all views
    const { addUserToLocals } = require('./middleware/auth');
    app.use(addUserToLocals);

    // Routes
    const authRoutes = require('./routes/auth');
    const studentRoutes = require('./routes/student');
    const adminRoutes = require('./routes/admin');

    app.use('/', authRoutes);
    app.use('/student', studentRoutes);
    app.use('/admin', adminRoutes);

    // Root redirect
    app.get('/', (req, res) => {
        if (req.session.userId) {
            return res.redirect(req.session.role === 'Admin' ? '/admin/dashboard' : '/student/dashboard');
        }
        res.redirect('/login');
    });

    // 404 handler
    app.use((req, res) => {
        res.status(404).render('error', { message: 'Page not found', activePage: '' });
    });

    // Error handler
    app.use((err, req, res, next) => {
        console.error(err.stack);
        res.status(500).render('error', { message: 'Something went wrong', activePage: '' });
    });

    app.listen(PORT, () => {
        console.log(`\n  🏨 Smart Hostel Room Allocation System`);
        console.log(`  ────────────────────────────────────`);
        console.log(`  Server running at http://localhost:${PORT}`);
        console.log(`  Admin login: admin@university.edu / admin123\n`);
    });
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
