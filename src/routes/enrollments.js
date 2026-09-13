const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query('SELECT course_id FROM enrollments WHERE user_id = $1', [req.user.id]);
    res.json({ courseIds: result.rows.map((r) => r.course_id) });
  } catch (e) { next(e); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { courseId } = req.body || {};
    const courseRes = await db.query('SELECT * FROM courses WHERE id = $1', [courseId]);
    const course = courseRes.rows[0];
    if (!course || course.status !== 'published') return res.status(404).json({ error: 'Course not available.' });
    await db.query(
      'INSERT INTO enrollments (id, user_id, course_id) VALUES ($1,$2,$3) ON CONFLICT (user_id, course_id) DO NOTHING',
      [db.genId('enroll'), req.user.id, courseId]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.get('/:courseId/progress', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT p.lesson_id, p.status, p.quiz_score FROM progress p
       JOIN lessons l ON l.id = p.lesson_id
       JOIN modules m ON m.id = l.module_id
       WHERE p.user_id = $1 AND m.course_id = $2`,
      [req.user.id, req.params.courseId]
    );
    const byLesson = {};
    result.rows.forEach((r) => { byLesson[r.lesson_id] = { status: r.status, quizScore: r.quiz_score }; });
    res.json({ progress: byLesson });
  } catch (e) { next(e); }
});

router.post('/lessons/:lessonId/progress', requireAuth, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    const finalStatus = status || 'in_progress';
    await db.query(
      `INSERT INTO progress (id, user_id, lesson_id, status) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, lesson_id) DO UPDATE SET status = $4, updated_at = now()`,
      [db.genId('prog'), req.user.id, req.params.lessonId, finalStatus]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
