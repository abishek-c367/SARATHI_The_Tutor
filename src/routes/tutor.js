const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callLLM } = require('../utils/llm');

const router = express.Router();

function systemPromptFor(course, lesson) {
  return `You are an expert, patient AI tutor teaching one lesson inside the course "${course.title}".
Lesson: "${lesson.title}"
Source material for this lesson (teach from this; do not go far outside its scope):
"""
${lesson.content}
"""

Teaching style:
- Teach interactively and incrementally: explain one idea at a time, build intuition before formalism (a short analogy or real-world framing), then give a concrete example.
- Keep each turn focused: roughly 120-350 words of explanation, plus at most one supporting code block, diagram, or quiz.
- Periodically check understanding with a short quiz before moving to the next concept, and adapt based on the answer (re-explain if the student struggled).
- Encourage and answer the student's own questions at any point, then gently steer back to the lesson.
- Include a code example when the material calls for it, and a diagram when it describes a structure, process, or relationship.
- When the lesson's key concepts have all been covered and checked, clearly state the lesson is complete and summarize the key takeaways in a short list.

Output format (strict):
- Plain prose/explanations: normal markdown (no special fences).
- Code: fence with the language, e.g. \`\`\`python ... \`\`\`
- Diagrams: fence with \`\`\`mermaid ... \`\`\` using valid Mermaid syntax.
- Quizzes: fence with \`\`\`quiz ... \`\`\` containing ONLY a JSON object of this exact shape:
  {"question": "...", "options": ["...", "...", "...", "..."], "correctIndex": 0, "explanation": "..."}
- At most one quiz per turn, and never put quiz JSON anywhere except inside a \`\`\`quiz fence.`;
}

async function loadLessonAndCourse(lessonId) {
  const result = await db.query(
    `SELECT l.id AS lesson_id, l.title AS lesson_title, l.content AS lesson_content,
            c.id AS course_id, c.title AS course_title
     FROM lessons l JOIN modules m ON m.id = l.module_id JOIN courses c ON c.id = m.course_id
     WHERE l.id = $1`,
    [lessonId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    lesson: { id: row.lesson_id, title: row.lesson_title, content: row.lesson_content },
    course: { id: row.course_id, title: row.course_title },
  };
}

async function assertAccess(req, res, lessonId) {
  const found = await loadLessonAndCourse(lessonId);
  if (!found) { res.status(404).json({ error: 'Lesson not found.' }); return null; }
  if (req.user.role !== 'ADMIN') {
    const enrolled = await db.query('SELECT 1 FROM enrollments WHERE user_id = $1 AND course_id = $2', [req.user.id, found.course.id]);
    if (!enrolled.rows.length) { res.status(403).json({ error: 'Enroll in this course first.' }); return null; }
  }
  return found;
}

async function getHistory(userId, lessonId) {
  const result = await db.query(
    'SELECT role, content FROM tutor_messages WHERE user_id = $1 AND lesson_id = $2 ORDER BY created_at ASC',
    [userId, lessonId]
  );
  return result.rows;
}
async function saveMessage(userId, lessonId, role, content) {
  await db.query(
    'INSERT INTO tutor_messages (id, user_id, lesson_id, role, content) VALUES ($1,$2,$3,$4,$5)',
    [db.genId('msg'), userId, lessonId, role, content]
  );
}
async function upsertProgress(userId, lessonId, status) {
  await db.query(
    `INSERT INTO progress (id, user_id, lesson_id, status) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [db.genId('prog'), userId, lessonId, status]
  );
}

router.get('/lessons/:lessonId/messages', requireAuth, async (req, res, next) => {
  try {
    const found = await assertAccess(req, res, req.params.lessonId);
    if (!found) return;
    const messages = await getHistory(req.user.id, req.params.lessonId);
    res.json({ messages });
  } catch (e) { next(e); }
});

router.post('/lessons/:lessonId/messages', requireAuth, async (req, res, next) => {
  try {
    const found = await assertAccess(req, res, req.params.lessonId);
    if (!found) return;
    const { lesson, course } = found;
    const { message, begin } = req.body || {};

    const history = await getHistory(req.user.id, lesson.id);
    const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));

    let userContent;
    if (begin) {
      userContent = `Begin the lesson. Greet me briefly by name (${req.user.name}) and start teaching the first concept.`;
    } else {
      if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
      userContent = message.trim();
    }
    apiMessages.push({ role: 'user', content: userContent });

    const reply = await callLLM({ system: systemPromptFor(course, lesson), messages: apiMessages, maxTokens: 1024 });

    if (!begin) await saveMessage(req.user.id, lesson.id, 'user', userContent);
    await saveMessage(req.user.id, lesson.id, 'assistant', reply);

    const looksComplete = /lesson (is )?complete/i.test(reply) || /you('| ha)ve (now )?completed this lesson/i.test(reply);
    await upsertProgress(req.user.id, lesson.id, looksComplete ? 'completed' : 'in_progress');

    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: 'The tutor could not respond: ' + e.message });
  }
});

router.post('/lessons/:lessonId/quiz-result', requireAuth, async (req, res, next) => {
  try {
    const found = await assertAccess(req, res, req.params.lessonId);
    if (!found) return;
    const { lesson, course } = found;
    const { chosenText, correct } = req.body || {};

    const history = await getHistory(req.user.id, lesson.id);
    const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));
    const instruction = `[Quiz answered] The student chose: "${chosenText}". This was ${correct ? 'CORRECT' : 'INCORRECT'}. Briefly acknowledge this, then continue the lesson (re-teach the point if incorrect, otherwise move forward).`;
    apiMessages.push({ role: 'user', content: instruction });

    const reply = await callLLM({ system: systemPromptFor(course, lesson), messages: apiMessages, maxTokens: 1024 });
    await saveMessage(req.user.id, lesson.id, 'user', instruction);
    await saveMessage(req.user.id, lesson.id, 'assistant', reply);
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: 'The tutor could not respond: ' + e.message });
  }
});

module.exports = router;
