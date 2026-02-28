const { dbReady, getDb } = require('./database');
const bcrypt = require('bcryptjs');

async function seed() {
  await dbReady;
  const db = getDb();

  console.log('Seeding database...');

  // Create admin user
  const adminPassword = bcrypt.hashSync('admin123', 10);
  const existingAdmin = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@university.edu');
  if (!existingAdmin) {
    db.prepare(`
      INSERT INTO users (student_id, full_name, department, year, email, password, role)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('ADMIN001', 'System Administrator', 'Administration', null, 'admin@university.edu', adminPassword, 'Admin');
  }

  // Create sample students with carefully designed preferences
  const studentPassword = bcrypt.hashSync('student123', 10);
  const students = [
    // ── Night owls who study with music (should pair well) ──
    {
      sid: 'STU2024001', name: 'Aarav Sharma', dept: 'Computer Science', year: 2, email: 'aarav@university.edu',
      sleep: 'Night Owl', study: 'Music', noise: 'High', clean: 'Medium', preferred: 'STU2024002', conflict: null
    },
    {
      sid: 'STU2024002', name: 'Priya Patel', dept: 'Computer Science', year: 2, email: 'priya@university.edu',
      sleep: 'Night Owl', study: 'Music', noise: 'High', clean: 'Medium', preferred: 'STU2024001', conflict: null
    },

    // ── Early birds who like silence (should pair well) ──
    {
      sid: 'STU2024003', name: 'Rahul Verma', dept: 'Electronics', year: 3, email: 'rahul@university.edu',
      sleep: 'Early Bird', study: 'Silent', noise: 'Low', clean: 'High', preferred: 'STU2024005', conflict: null
    },
    {
      sid: 'STU2024004', name: 'Sneha Gupta', dept: 'Mechanical', year: 2, email: 'sneha@university.edu',
      sleep: 'Early Bird', study: 'Silent', noise: 'Low', clean: 'High', preferred: null, conflict: 'STU2024006'
    },
    {
      sid: 'STU2024005', name: 'Vikram Singh', dept: 'Electronics', year: 3, email: 'vikram@university.edu',
      sleep: 'Early Bird', study: 'Silent', noise: 'Low', clean: 'High', preferred: 'STU2024003', conflict: null
    },

    // ── Flexible/group study types ──
    {
      sid: 'STU2024006', name: 'Anjali Nair', dept: 'Computer Science', year: 1, email: 'anjali@university.edu',
      sleep: 'Flexible', study: 'Group Study', noise: 'High', clean: 'Low', preferred: null, conflict: 'STU2024004'
    },
    {
      sid: 'STU2024007', name: 'Rohan Das', dept: 'Civil', year: 4, email: 'rohan@university.edu',
      sleep: 'Flexible', study: 'Group Study', noise: 'Medium', clean: 'Medium', preferred: null, conflict: null
    },
    {
      sid: 'STU2024008', name: 'Meera Iyer', dept: 'Computer Science', year: 3, email: 'meera@university.edu',
      sleep: 'Night Owl', study: 'Music', noise: 'High', clean: 'Low', preferred: null, conflict: null
    },

    // ── Additional students for realistic density ──
    {
      sid: 'STU2024009', name: 'Arjun Reddy', dept: 'Electrical', year: 2, email: 'arjun@university.edu',
      sleep: 'Night Owl', study: 'Silent', noise: 'Medium', clean: 'High', preferred: null, conflict: null
    },
    {
      sid: 'STU2024010', name: 'Kavya Menon', dept: 'Computer Science', year: 1, email: 'kavya@university.edu',
      sleep: 'Early Bird', study: 'Music', noise: 'Low', clean: 'Medium', preferred: null, conflict: null
    },
    {
      sid: 'STU2024011', name: 'Aditya Kumar', dept: 'Electronics', year: 2, email: 'aditya@university.edu',
      sleep: 'Flexible', study: 'Group Study', noise: 'High', clean: 'Medium', preferred: 'STU2024007', conflict: null
    },
    {
      sid: 'STU2024012', name: 'Isha Desai', dept: 'Chemical', year: 3, email: 'isha@university.edu',
      sleep: 'Early Bird', study: 'Silent', noise: 'Low', clean: 'High', preferred: null, conflict: null
    },
  ];

  for (const s of students) {
    const existing = db.prepare('SELECT id FROM users WHERE student_id = ?').get(s.sid);
    if (!existing) {
      db.prepare(`
        INSERT INTO users (student_id, full_name, department, year, email, password, role)
        VALUES (?, ?, ?, ?, ?, ?, 'Student')
      `).run(s.sid, s.name, s.dept, s.year, s.email, studentPassword);

      const user = db.prepare('SELECT id FROM users WHERE student_id = ?').get(s.sid);
      if (user) {
        db.prepare(`
          INSERT INTO preferences (user_id, sleep_type, study_style, noise_tolerance, cleanliness_level, preferred_roommate, conflict_list)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(user.id, s.sleep, s.study, s.noise, s.clean, s.preferred, s.conflict);
      }
    }
  }

  // Create rooms — deliberately fewer beds to force roommate pairing
  // 4 rooms × 3 capacity = 12 beds for 12 students → rooms WILL fill up
  const rooms = [
    ['A-101', 3],
    ['A-102', 3],
    ['B-201', 3],
    ['B-202', 3],
  ];

  for (const [num, cap] of rooms) {
    const existingRoom = db.prepare('SELECT id FROM rooms WHERE room_number = ?').get(num);
    if (!existingRoom) {
      db.prepare('INSERT INTO rooms (room_number, capacity) VALUES (?, ?)').run(num, cap);
    }
  }

  console.log('✓ Admin user created (admin@university.edu / admin123)');
  console.log('✓ 12 sample students created (password: student123)');
  console.log('✓ 4 rooms created (3 capacity each = 12 beds total)');

  // Create fee records for all students
  const allStudents = db.prepare('SELECT id FROM users WHERE role = ?').all('Student');
  const feeInsert = db.prepare(`
    INSERT OR IGNORE INTO fees (user_id, total_amount, amount_paid, due_date, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  const statuses = ['Pending', 'Pending', 'Paid', 'Pending', 'Overdue'];
  allStudents.forEach((s, i) => {
    const paid = statuses[i % 5] === 'Paid' ? 50000 : statuses[i % 5] === 'Overdue' ? 10000 : 0;
    feeInsert.run(s.id, 50000, paid, '2026-03-31', statuses[i % 5]);
  });
  console.log('✓ Fee records created for all students');

  // Create welcome notifications
  const notifInsert = db.prepare(`
    INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)
  `);
  allStudents.forEach(s => {
    notifInsert.run(s.id, 'Welcome to Smart Hostel! Please set your room preferences.', 'info');
  });
  // Admin notification
  const admin = db.prepare('SELECT id FROM users WHERE role = ?').get('Admin');
  if (admin) {
    notifInsert.run(admin.id, 'System initialized. 12 students registered.', 'success');
    notifInsert.run(admin.id, 'Hostel fees set for current academic year.', 'info');
  }
  console.log('✓ Notifications created');

  console.log('Database seeded successfully!');
}

seed().catch(err => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
