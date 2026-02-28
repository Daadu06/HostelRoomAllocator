/**
 * Authentication Middleware
 * Shared between both Student Portal and Admin Panel.
 */

function requireAuth(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login');
    }
    if (req.session.role !== 'Admin') {
        return res.redirect('/login');
    }
    next();
}

function requireStudent(req, res, next) {
    if (!req.session || !req.session.userId) {
        return res.redirect('/login');
    }
    if (req.session.role !== 'Student') {
        return res.redirect('/login');
    }
    next();
}

function addUserToLocals(req, res, next) {
    res.locals.currentUser = req.session.userId ? {
        id: req.session.userId,
        fullName: req.session.fullName,
        role: req.session.role,
        email: req.session.email
    } : null;
    next();
}

module.exports = { requireAuth, requireAdmin, requireStudent, addUserToLocals };
