const express = require('express');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { callLLM } = require('../utils/llm');

const router = express.Router();

function courseRow(r) {
  return { id: r.id, title: r.title, description: r.description, status: r.status, createdAt: r.created_at };
}
function moduleRow(r) { return { id: r.id, title: r.title, order: r.order }; }
function lessonRow(r) { return { id: r.id, title: r.title, content: r.content, order: r.order }; }

async function attachCurriculum(course) {
  const modsRes = await db.query('SELECT * FROM modules WHERE course_id = $1 ORDER BY "order" ASC', [course.id]);
  const modules = [];
  for (const m of modsRes.rows) {
    const lessonsRes = await db.query('SELECT * FROM lessons WHERE module_id = $1 ORDER BY "order" ASC', [m.id]);
    modules.push({ ...moduleRow(m), lessons: lessonsRes.rows.map(lessonRow) });
  }
  return { ...courseRow(course), modules };
}

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const result = req.user.role === 'ADMIN'
      ? await db.query('SELECT * FROM courses ORDER BY created_at DESC')
      : await db.query("SELECT * FROM courses WHERE status = 'published' ORDER BY created_at DESC");
    const courses = [];
    for (const c of result.rows) courses.push(await attachCurriculum(c));
    res.json({ courses });
  } catch (e) { next(e); }
});

router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: 'Course not found.' });
    if (row.status !== 'published' && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'This course is not published yet.' });
    }
    res.json({ course: await attachCurriculum(row) });
  } catch (e) { next(e); }
});

router.post('/', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, description } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const id = db.genId('course');
    const result = await db.query(
      'INSERT INTO courses (id, title, description) VALUES ($1,$2,$3) RETURNING *',
      [id, title, description || '']
    );
    res.json({ course: courseRow(result.rows[0]) });
  } catch (e) { next(e); }
});

router.patch('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, description, status } = req.body || {};
    const existing = await db.query('SELECT * FROM courses WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Course not found.' });
    const merged = {
      title: title !== undefined ? title : existing.rows[0].title,
      description: description !== undefined ? description : existing.rows[0].description,
      status: status !== undefined ? (status === 'published' ? 'published' : 'draft') : existing.rows[0].status,
    };
    const result = await db.query(
      'UPDATE courses SET title=$1, description=$2, status=$3 WHERE id=$4 RETURNING *',
      [merged.title, merged.description, merged.status, req.params.id]
    );
    res.json({ course: courseRow(result.rows[0]) });
  } catch (e) { next(e); }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM courses WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Modules ----
router.post('/:id/modules', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Module title is required.' });
    const countRes = await db.query('SELECT COUNT(*)::int AS n FROM modules WHERE course_id = $1', [req.params.id]);
    const id = db.genId('mod');
    const result = await db.query(
      'INSERT INTO modules (id, title, "order", course_id) VALUES ($1,$2,$3,$4) RETURNING *',
      [id, title, countRes.rows[0].n, req.params.id]
    );
    res.json({ module: moduleRow(result.rows[0]) });
  } catch (e) { next(e); }
});

router.delete('/modules/:moduleId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM modules WHERE id = $1', [req.params.moduleId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- Lessons ----
router.post('/modules/:moduleId/lessons', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, content } = req.body || {};
    if (!title || !content) return res.status(400).json({ error: 'Lesson title and content are required.' });
    const countRes = await db.query('SELECT COUNT(*)::int AS n FROM lessons WHERE module_id = $1', [req.params.moduleId]);
    const id = db.genId('lesson');
    const result = await db.query(
      'INSERT INTO lessons (id, title, content, "order", module_id) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [id, title, content, countRes.rows[0].n, req.params.moduleId]
    );
    res.json({ lesson: lessonRow(result.rows[0]) });
  } catch (e) { next(e); }
});

router.patch('/lessons/:lessonId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, content } = req.body || {};
    const existing = await db.query('SELECT * FROM lessons WHERE id = $1', [req.params.lessonId]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'Lesson not found.' });
    const merged = {
      title: title !== undefined ? title : existing.rows[0].title,
      content: content !== undefined ? content : existing.rows[0].content,
    };
    const result = await db.query('UPDATE lessons SET title=$1, content=$2 WHERE id=$3 RETURNING *', [merged.title, merged.content, req.params.lessonId]);
    res.json({ lesson: lessonRow(result.rows[0]) });
  } catch (e) { next(e); }
});

router.delete('/lessons/:lessonId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM lessons WHERE id = $1', [req.params.lessonId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---- AI-assisted outline generation (proposal only, not saved) ----
router.post('/:id/generate-outline', requireAuth, requireAdmin, async (req, res) => {
  const { rawText } = req.body || {};
  if (!rawText || rawText.trim().length < 20) {
    return res.status(400).json({ error: 'Paste some course material first.' });
  }
  const system = `You convert raw course material into a structured curriculum. Respond with ONLY valid JSON, no prose, no markdown fences. Shape:
{"modules":[{"title":"...", "lessons":[{"title":"...", "content":"..."}]}]}
Rules:
- Break the material into 2-5 modules, each with 2-5 lessons.
- Each lesson's "content" field should be a self-contained rewrite (200-500 words) of the relevant material: definitions, key points, and any examples present in the source, organized so a tutor could teach directly from it.
- Keep lesson titles short and specific.
- Do not invent facts not implied by the source material.`;
  try {
    const text = await callLLM({ system, messages: [{ role: 'user', content: rawText.slice(0, 30000) }], maxTokens: 4000 });
    const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    res.json({ outline: parsed });
  } catch (e) {
    res.status(502).json({ error: 'Could not generate an outline: ' + e.message });
  }
});

router.post('/:id/apply-outline', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { outline } = req.body || {};
    if (!outline || !Array.isArray(outline.modules)) return res.status(400).json({ error: 'Malformed outline.' });
    const courseId = req.params.id;
    const countRes = await db.query('SELECT COUNT(*)::int AS n FROM modules WHERE course_id = $1', [courseId]);
    let moduleOrder = countRes.rows[0].n;
    for (const m of outline.modules) {
      const modId = db.genId('mod');
      await db.query('INSERT INTO modules (id, title, "order", course_id) VALUES ($1,$2,$3,$4)', [modId, m.title || 'Untitled module', moduleOrder++, courseId]);
      let lessonOrder = 0;
      for (const l of m.lessons || []) {
        await db.query('INSERT INTO lessons (id, title, content, "order", module_id) VALUES ($1,$2,$3,$4,$5)', [db.genId('lesson'), l.title || 'Untitled lesson', l.content || '', lessonOrder++, modId]);
      }
    }
    const result = await db.query('SELECT * FROM courses WHERE id = $1', [courseId]);
    res.json({ course: await attachCurriculum(result.rows[0]) });
  } catch (e) { next(e); }
});

module.exports = router;
