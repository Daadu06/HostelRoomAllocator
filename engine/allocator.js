const { getDb } = require('../db/database');
const { calculateCompatibility, hasConflict } = require('./compatibility');

/**
 * Greedy room allocation algorithm.
 *
 * Strategy: "Fill-First" — prefer placing students into rooms that already
 * have occupants (to maximise compatibility scoring), and only use empty
 * rooms as a last resort.  Among occupied rooms, pick the one with the
 * highest average compatibility.  Among empty rooms, pick the smallest
 * capacity first (so we don't waste large rooms on lone students).
 */
function runAllocation() {
    const db = getDb();
    const results = { allocated: 0, skipped: 0, errors: [] };

    const unallocatedStudents = db.prepare(`
        SELECT u.id, u.student_id, u.full_name, u.department, u.year,
               p.sleep_type, p.study_style, p.noise_tolerance, p.cleanliness_level,
               p.preferred_roommate, p.conflict_list
        FROM users u
        LEFT JOIN preferences p ON u.id = p.user_id
        LEFT JOIN allocations a ON u.id = a.user_id
        WHERE u.role = 'Student' AND a.id IS NULL
        ORDER BY u.id
    `).all();

    if (unallocatedStudents.length === 0) {
        return results;
    }

    for (const student of unallocatedStudents) {
        try {
            // Refresh available rooms for every student
            const rooms = db.prepare(`
                SELECT * FROM rooms WHERE current_occupancy < capacity
                ORDER BY room_number
            `).all();

            if (rooms.length === 0) {
                results.skipped++;
                continue;
            }

            let bestOccupiedRoom = null;
            let bestOccupiedScore = -Infinity;

            let bestEmptyRoom = null; // fallback — only used if no occupied room fits

            for (const room of rooms) {
                const occupants = db.prepare(`
                    SELECT u.id, u.student_id, u.full_name, u.department, u.year,
                           p.sleep_type, p.study_style, p.noise_tolerance, p.cleanliness_level,
                           p.preferred_roommate, p.conflict_list
                    FROM allocations a
                    JOIN users u ON a.user_id = u.id
                    LEFT JOIN preferences p ON u.id = p.user_id
                    WHERE a.room_id = ?
                `).all(room.id);

                // ── Empty room? Remember it as fallback ──
                if (occupants.length === 0) {
                    // Prefer the smallest empty room (don't waste big rooms)
                    if (!bestEmptyRoom || room.capacity < bestEmptyRoom.capacity) {
                        bestEmptyRoom = room;
                    }
                    continue;
                }

                // ── Room has occupants → score compatibility ──
                let hasConflictFlag = false;
                let totalScore = 0;

                for (const occupant of occupants) {
                    if (hasConflict(student, occupant)) {
                        hasConflictFlag = true;
                        break;
                    }
                    totalScore += calculateCompatibility(student, occupant);
                }

                if (hasConflictFlag) continue;

                const avgScore = totalScore / occupants.length;

                if (avgScore > bestOccupiedScore) {
                    bestOccupiedScore = avgScore;
                    bestOccupiedRoom = room;
                }
            }

            // ── Decision: prefer occupied rooms, fall back to empty ──
            let chosenRoom = null;
            let chosenScore = 0;

            if (bestOccupiedRoom && bestOccupiedScore >= 0) {
                // Good or neutral match found in an occupied room
                chosenRoom = bestOccupiedRoom;
                chosenScore = bestOccupiedScore;
            } else if (bestEmptyRoom) {
                // No compatible occupied room → use an empty room
                chosenRoom = bestEmptyRoom;
                chosenScore = 0;
            } else if (bestOccupiedRoom) {
                // Only negative-score occupied rooms exist (still better than nothing)
                chosenRoom = bestOccupiedRoom;
                chosenScore = bestOccupiedScore;
            }

            if (chosenRoom) {
                db.prepare(`
                    INSERT INTO allocations (user_id, room_id, compatibility_score)
                    VALUES (?, ?, ?)
                `).run(student.id, chosenRoom.id, Math.max(0, chosenScore));

                const newOccupancy = chosenRoom.current_occupancy + 1;
                const newStatus = newOccupancy >= chosenRoom.capacity ? 'Full' : 'Available';
                db.prepare(`
                    UPDATE rooms SET current_occupancy = ?, status = ? WHERE id = ?
                `).run(newOccupancy, newStatus, chosenRoom.id);

                results.allocated++;
            } else {
                results.skipped++;
            }
        } catch (err) {
            results.errors.push(`Failed to allocate ${student.full_name}: ${err.message}`);
        }
    }

    // ── Post-allocation pass: recalculate all scores ──
    // The first student placed in each room gets 0 because they had no
    // roommates at assignment time.  Now that every room is populated,
    // recalculate every student's average compatibility with their actual
    // roommates so the scores reflect reality.
    const allRooms = db.prepare('SELECT id FROM rooms WHERE current_occupancy > 0').all();
    for (const room of allRooms) {
        const occupants = db.prepare(`
            SELECT a.id as alloc_id, u.id as uid, u.student_id, u.department,
                   p.sleep_type, p.study_style, p.preferred_roommate, p.conflict_list
            FROM allocations a
            JOIN users u ON a.user_id = u.id
            LEFT JOIN preferences p ON u.id = p.user_id
            WHERE a.room_id = ?
        `).all(room.id);

        if (occupants.length <= 1) continue; // solo → score stays 0

        for (const student of occupants) {
            let totalScore = 0;
            let count = 0;
            for (const mate of occupants) {
                if (mate.uid === student.uid) continue;
                totalScore += calculateCompatibility(student, mate);
                count++;
            }
            const avgScore = count > 0 ? Math.max(0, totalScore / count) : 0;
            db.prepare('UPDATE allocations SET compatibility_score = ? WHERE id = ?')
                .run(parseFloat(avgScore.toFixed(1)), student.alloc_id);
        }
    }

    return results;
}

function resetAllocations() {
    const db = getDb();
    db.prepare('DELETE FROM allocations').run();
    db.prepare("UPDATE rooms SET current_occupancy = 0, status = 'Available'").run();
}

module.exports = { runAllocation, resetAllocations };
