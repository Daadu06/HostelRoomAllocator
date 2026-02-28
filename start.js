/**
 * ── Combined Launcher ──────────────────────────────────
 *    Starts both the Student Portal and Admin Panel
 *    as two independent servers on separate ports.
 *
 *    Student Portal → http://localhost:3000
 *    Admin Panel    → http://localhost:3001
 * ────────────────────────────────────────────────────────
 */

require('dotenv').config();
const startStudentServer = require('./server-student');
const startAdminServer = require('./server-admin');
const { getDb, dbReady, archiveExpiredMessages, deleteExpiredAnnouncements, archiveExpiredOutpasses } = require('./db/database');

async function startAll() {
    console.log('\n  🏨 Smart Hostel Room Allocation System');
    console.log('  ────────────────────────────────────────\n');

    await startStudentServer();
    await startAdminServer();
    await dbReady;

    console.log('\n  ────────────────────────────────────────');
    console.log('  ✅ Both servers are running!');

    // Start background worker for archival
    setInterval(() => {
        try {
            const count = archiveExpiredMessages(getDb());
            if (count > 0) {
                console.log(`[Background Job] Safely archived ${count} expired messages.`);
            }
        } catch (e) {
            console.error('[Background Job] Failed to archive messages:', e);
        }
    }, 1000 * 60 * 60); // Check every hour

    // Run an initial sweep on startup
    try {
        const count = archiveExpiredMessages(getDb());
        if (count > 0) {
            console.log(`[Startup] Safely archived ${count} expired messages.`);
        }
    } catch (e) {
        console.error('[Startup] Failed to archive messages:', e);
    }

    // Announcement cleanup: delete announcements older than 30 days
    setInterval(() => {
        try {
            const count = deleteExpiredAnnouncements(getDb());
            if (count > 0) {
                console.log(`[Background Job] Deleted ${count} expired announcements.`);
            }
        } catch (e) {
            console.error('[Background Job] Failed to delete expired announcements:', e);
        }
    }, 1000 * 60 * 60); // Check every hour

    // Initial sweep on startup
    try {
        const count = deleteExpiredAnnouncements(getDb());
        if (count > 0) {
            console.log(`[Startup] Deleted ${count} expired announcements.`);
        }
    } catch (e) {
        console.error('[Startup] Failed to delete expired announcements:', e);
    }

    // Outpass archival: move expired outpass requests to archive
    setInterval(() => {
        try {
            const count = archiveExpiredOutpasses(getDb());
            if (count > 0) {
                console.log(`[Background Job] Archived ${count} expired outpass requests.`);
            }
        } catch (e) {
            console.error('[Background Job] Failed to archive outpass requests:', e);
        }
    }, 1000 * 60 * 60); // Check every hour

    // Initial sweep on startup
    try {
        const count = archiveExpiredOutpasses(getDb());
        if (count > 0) {
            console.log(`[Startup] Archived ${count} expired outpass requests.`);
        }
    } catch (e) {
        console.error('[Startup] Failed to archive outpass requests:', e);
    }
    console.log('\n');
}

startAll().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
