require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

async function upsertUser(name, email, password, role) {
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows[0]) return existing.rows[0].id;
  const id = db.genId('user');
  const hashed = await bcrypt.hash(password, 10);
  await db.query('INSERT INTO users (id, name, email, password, role) VALUES ($1,$2,$3,$4,$5)', [id, name, email, hashed, role]);
  return id;
}

async function main() {
  await upsertUser('Admin', 'admin@tutorly.dev', 'admin123', 'ADMIN');
  await upsertUser('Sam Student', 'student@tutorly.dev', 'student123', 'STUDENT');

  const existingCourse = await db.query("SELECT id FROM courses WHERE title = 'Intro to Probability'");
  if (!existingCourse.rows[0]) {
    const courseId = db.genId('course');
    await db.query(
      "INSERT INTO courses (id, title, description, status) VALUES ($1,$2,$3,'published')",
      [courseId, 'Intro to Probability', 'A gentle first course on probability: outcomes, events, and how to reason about uncertainty.']
    );
    const modId = db.genId('mod');
    await db.query('INSERT INTO modules (id, title, "order", course_id) VALUES ($1,$2,0,$3)', [modId, 'Foundations', courseId]);

    await db.query(
      'INSERT INTO lessons (id, title, content, "order", module_id) VALUES ($1,$2,$3,0,$4)',
      [
        db.genId('lesson'),
        'Sample spaces and events',
        'A sample space is the set of all possible outcomes of a random experiment (e.g. rolling a die: {1,2,3,4,5,6}). ' +
        'An event is any subset of the sample space (e.g. "rolling an even number" = {2,4,6}). ' +
        'The probability of an event, assuming equally likely outcomes, is the number of outcomes in the event divided by ' +
        'the total number of outcomes in the sample space. Example: P(even) = 3/6 = 1/2. Key intuition: probability is about ' +
        'counting favorable outcomes relative to all possible outcomes, and this idea generalizes far beyond dice and coins.',
        modId,
      ]
    );
    await db.query(
      'INSERT INTO lessons (id, title, content, "order", module_id) VALUES ($1,$2,$3,1,$4)',
      [
        db.genId('lesson'),
        'Independence and conditional probability',
        'Two events are independent if the occurrence of one does not change the probability of the other (e.g. two separate coin ' +
        'flips). Conditional probability P(A|B) is the probability of A given that B has already happened, computed as ' +
        'P(A and B) / P(B). Example: drawing two cards without replacement - the probability the second card is an ace depends on ' +
        'whether the first card drawn was an ace, so these events are NOT independent. This distinction (independent vs dependent ' +
        'events) is one of the most common sources of confusion for beginners and is worth dwelling on with concrete examples.',
        modId,
      ]
    );
    console.log('Seeded demo course: Intro to Probability');
  }

  console.log('Seed complete.');
  console.log('Admin login:   admin@tutorly.dev / admin123');
  console.log('Student login: student@tutorly.dev / student123');
  await db.pool.end();
}

main().catch((e) => { console.error('Seed failed:', e.message); process.exit(1); });
