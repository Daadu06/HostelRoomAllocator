/**
 * Compatibility Scoring Engine
 *
 * Calculates a compatibility score between two students based on:
 * +3  → Same sleep type
 * +2  → Same study style
 * +2  → Same department
 * +5  → Preferred roommate match
 * -10 → Conflict detected
 */

function calculateCompatibility(studentA, studentB) {
    let score = 0;

    // Sleep type match
    if (studentA.sleep_type && studentB.sleep_type && studentA.sleep_type === studentB.sleep_type) {
        score += 3;
    }

    // Study style match
    if (studentA.study_style && studentB.study_style && studentA.study_style === studentB.study_style) {
        score += 2;
    }

    // Same department
    if (studentA.department && studentB.department && studentA.department === studentB.department) {
        score += 2;
    }

    // Preferred roommate (check both directions)
    if (
        (studentA.preferred_roommate && studentA.preferred_roommate === studentB.student_id) ||
        (studentB.preferred_roommate && studentB.preferred_roommate === studentA.student_id)
    ) {
        score += 5;
    }

    // Conflict check (both directions)
    const conflictsA = studentA.conflict_list ? studentA.conflict_list.split(',').map(s => s.trim()) : [];
    const conflictsB = studentB.conflict_list ? studentB.conflict_list.split(',').map(s => s.trim()) : [];

    if (conflictsA.includes(studentB.student_id) || conflictsB.includes(studentA.student_id)) {
        score -= 10;
    }

    return score;
}

function hasConflict(studentA, studentB) {
    const conflictsA = studentA.conflict_list ? studentA.conflict_list.split(',').map(s => s.trim()) : [];
    const conflictsB = studentB.conflict_list ? studentB.conflict_list.split(',').map(s => s.trim()) : [];
    return conflictsA.includes(studentB.student_id) || conflictsB.includes(studentA.student_id);
}

module.exports = { calculateCompatibility, hasConflict };
