const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { callLLM } = require('../utils/llm');

const router = express.Router();

/* -------------------------------------------------------------------------
   Student memory: a per-user profile (level + running notes) that persists
   across every course the student takes, plus per-topic mastery within
   each lesson. The tutor reads both before responding and can update them
   after every turn via a hidden ```meta fenced block in its reply (parsed
   out server-side, never shown to the student).
------------------------------------------------------------------------- */

async function getProfile(userId) {
  const result = await db.query('SELECT * FROM student_profile WHERE user_id = $1', [userId]);
  if (result.rows[0]) return result.rows[0];
  await db.query('INSERT INTO student_profile (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  return { user_id: userId, level: 'beginner', notes: '' };
}

async function updateProfile(userId, { level, noteAppend }) {
  const current = await getProfile(userId);
  let notes = current.notes || '';
  if (noteAppend) {
    notes = (notes ? notes + ' ' : '') + noteAppend;
    if (notes.length > 1200) notes = notes.slice(notes.length - 1200); // keep it bounded
  }
  await db.query(
    `INSERT INTO student_profile (user_id, level, notes, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (user_id) DO UPDATE SET level = $2, notes = $3, updated_at = now()`,
    [userId, level || current.level, notes]
  );
}

async function getTopics(lessonId) {
  const result = await db.query('SELECT * FROM lesson_topics WHERE lesson_id = $1 ORDER BY "order" ASC', [lessonId]);
  return result.rows;
}

async function getMastery(userId, topicIds) {
  if (!topicIds.length) return {};
  const result = await db.query('SELECT topic_id, status FROM concept_mastery WHERE user_id = $1 AND topic_id = ANY($2)', [userId, topicIds]);
  const map = {};
  result.rows.forEach((r) => { map[r.topic_id] = r.status; });
  return map;
}

async function setMastery(userId, topicId, status) {
  await db.query(
    `INSERT INTO concept_mastery (id, user_id, topic_id, status) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, topic_id) DO UPDATE SET status = $4, updated_at = now()`,
    [db.genId('mastery'), userId, topicId, status]
  );
}

/* Strips a ```meta {...} ``` fenced block out of a reply, applies any state
   updates it contains, and returns the reply with the meta fence removed
   from what gets shown to the student (it's still stored in full in the DB
   so the model's own conversation history stays self-consistent). */
async function applyMetaAndStrip(userId, reply) {
  const metaMatch = reply.match(/```meta\s*\n([\s\S]*?)```/);
  if (!metaMatch) return reply;
  try {
    const meta = JSON.parse(metaMatch[1].trim());
    if (meta.topicId && meta.topicStatus) {
      await setMastery(userId, meta.topicId, meta.topicStatus);
    }
    if (meta.level || meta.profileNote) {
      await updateProfile(userId, { level: meta.level, noteAppend: meta.profileNote });
    }
  } catch (e) {
    // malformed meta block - ignore it rather than fail the whole turn
  }
  return reply;
}

function systemPromptFor(course, lesson, topics, masteryMap, profile) {
  const topicList = topics.length
    ? topics.map((t, i) => `${i + 1}. [id: ${t.id}] ${t.title} - status: ${masteryMap[t.id] || 'not_started'}`).join('\n')
    : '(No topic checklist defined for this lesson - teach the material as a single flowing topic.)';

  return `You are an expert, patient AI tutor teaching one lesson inside the course "${course.title}".
Lesson: "${lesson.title}"
Source material for this lesson (teach from this; do not go far outside its scope):
"""
${lesson.content}
"""

TOPIC CHECKLIST for this lesson (teach these IN ORDER, one at a time - do not move to the next topic until the current one reaches "mastered" or "practiced"; if a topic is "struggling", re-teach it a different way before moving on):
${topicList}

WHAT YOU KNOW ABOUT THIS STUDENT (persists across all their courses - use it to personalize your teaching style, pacing, and choice of examples):
- Level: ${profile.level}
- Notes from previous sessions: ${profile.notes || '(none yet - this may be an early session with them)'}

Teaching style:
- Teach interactively and incrementally: explain one idea at a time, build intuition before formalism (a short analogy or real-world framing), then a concrete example.
- Keep each turn focused: roughly 120-350 words of explanation, plus at most one supporting code block, diagram, quiz, or exercise.
- Check understanding with a short quiz before advancing a topic, and adapt based on the answer.
- Include a code example when it helps, and a Mermaid diagram when the material describes a structure, process, or relationship.
- When it suits the material, give the student a hands-on coding exercise (see the \`\`\`exercise format below) instead of just a quiz - this is especially good for programming-related lessons.
- Adjust your depth and pace to the student's level and notes above. If notes mention a specific confusion or preference, act on it.
- When every topic is mastered/practiced, clearly say the lesson is complete and summarize key takeaways.

OUTPUT FORMAT (strict):
- Plain prose/explanations: normal markdown (no special fences).
- Code shown for reading: fence with the language, e.g. \`\`\`python ... \`\`\`
- Diagrams: fence with \`\`\`mermaid ... \`\`\` using valid Mermaid syntax.
- Quizzes: fence with \`\`\`quiz ... \`\`\` containing ONLY JSON: {"question": "...", "options": ["...","...","...","..."], "correctIndex": 0, "explanation": "..."}
- Coding exercises the student should write/run themselves: fence with \`\`\`exercise ... \`\`\` containing ONLY JSON:
  {"language": "python" or "javascript", "prompt": "what to implement", "starterCode": "..."}
  (Only use "python" or "javascript" for exercises - those are the two the student can actually run.)
- At the END of every reply, include exactly one hidden state-update block (the student never sees this) fenced as \`\`\`meta ... \`\`\` containing ONLY JSON:
  {"topicId": "<id of the topic you just addressed, or null>", "topicStatus": "introduced|practiced|struggling|mastered|null", "level": "beginner|intermediate|advanced|null", "profileNote": "<a short new observation about this student to remember, or null>"}
  Use topic ids EXACTLY as given in the checklist above. Only set profileNote when you've actually learned something new and specific about how this student learns; otherwise use null. Always include this block, even if all fields are null.`;
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
  const result = await db.query('SELECT role, content FROM tutor_messages WHERE user_id = $1 AND lesson_id = $2 ORDER BY created_at ASC', [userId, lessonId]);
  return result.rows;
}
async function saveMessage(userId, lessonId, role, content) {
  await db.query('INSERT INTO tutor_messages (id, user_id, lesson_id, role, content) VALUES ($1,$2,$3,$4,$5)', [db.genId('msg'), userId, lessonId, role, content]);
}
async function upsertProgress(userId, lessonId, status) {
  await db.query(
    `INSERT INTO progress (id, user_id, lesson_id, status) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, lesson_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [db.genId('prog'), userId, lessonId, status]
  );
}

async function respond(req, res, lesson, course, apiMessages) {
  const topics = await getTopics(lesson.id);
  const mastery = await getMastery(req.user.id, topics.map((t) => t.id));
  const profile = await getProfile(req.user.id);
  const reply = await callLLM({ system: systemPromptFor(course, lesson, topics, mastery, profile), messages: apiMessages, maxTokens: 1200 });
  await applyMetaAndStrip(req.user.id, reply);

  const looksComplete = /lesson (is )?complete/i.test(reply) || /you('| ha)ve (now )?completed this lesson/i.test(reply);
  await upsertProgress(req.user.id, lesson.id, looksComplete ? 'completed' : 'in_progress');
  return reply;
}

// ---- Topic progress (for the sidebar checklist in the lesson view) ----
router.get('/lessons/:lessonId/progress', requireAuth, async (req, res, next) => {
  try {
    const found = await assertAccess(req, res, req.params.lessonId);
    if (!found) return;
    const topics = await getTopics(found.lesson.id);
    const mastery = await getMastery(req.user.id, topics.map((t) => t.id));
    res.json({ topics: topics.map((t) => ({ id: t.id, title: t.title, status: mastery[t.id] || 'not_started' })) });
  } catch (e) { next(e); }
});

router.get('/lessons/:lessonId/messages', requireAuth, async (req, res, next) => {
  try {
    const found = await assertAccess(req, res, req.params.lessonId);
    if (!found) return;
    const messages = await getHistory(req.user.id, req.params.lessonId);
    res.json({ messages });
  } catch (e) { next(e); }
});

router.post('/lessons/:lessonId/messages', requireAuth, async (req, res) => {
  try {
    const found = await assertAccess(req, res, req.params.lessonId);
    if (!found) return;
    const { lesson, course } = found;
    const { message, begin } = req.body || {};

    const history = await getHistory(req.user.id, lesson.id);
    const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));

    let userContent;
    if (begin) {
      userContent = `Begin the lesson. Greet me briefly by name (${req.user.name}) and start teaching the first topic on the checklist.`;
    } else {
      if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
      userContent = message.trim();
    }
    apiMessages.push({ role: 'user', content: userContent });

    const reply = await respond(req, res, lesson, course, apiMessages);
    if (!begin) await saveMessage(req.user.id, lesson.id, 'user', userContent);
    await saveMessage(req.user.id, lesson.id, 'assistant', reply);
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: 'The tutor could not respond: ' + e.message });
  }
});

router.post('/lessons/:lessonId/quiz-result', requireAuth, async (req, res) => {
  try {
    const found = await assertAccess(req, res, req.params.lessonId);
    if (!found) return;
    const { lesson, course } = found;
    const { chosenText, correct } = req.body || {};

    const history = await getHistory(req.user.id, lesson.id);
    const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));
    const instruction = `[Quiz answered] The student chose: "${chosenText}". This was ${correct ? 'CORRECT' : 'INCORRECT'}. Briefly acknowledge this, then continue the lesson (re-teach the point if incorrect, otherwise advance the topic checklist).`;
    apiMessages.push({ role: 'user', content: instruction });

    const reply = await respond(req, res, lesson, course, apiMessages);
    await saveMessage(req.user.id, lesson.id, 'user', instruction);
    await saveMessage(req.user.id, lesson.id, 'assistant', reply);
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: 'The tutor could not respond: ' + e.message });
  }
});

// The student ran their exercise code client-side (Pyodide / sandboxed worker) -
// we send the code + real output back to the tutor for feedback and a mastery update.
router.post('/lessons/:lessonId/code-result', requireAuth, async (req, res) => {
  try {
    const found = await assertAccess(req, res, req.params.lessonId);
    if (!found) return;
    const { lesson, course } = found;
    const { language, code, stdout, stderr } = req.body || {};
    if (!code) return res.status(400).json({ error: 'No code provided.' });

    const history = await getHistory(req.user.id, lesson.id);
    const apiMessages = history.map((m) => ({ role: m.role, content: m.content }));
    const instruction = `[Code submitted] The student ran this ${language || ''} code:\n\`\`\`${language || ''}\n${code}\n\`\`\`\nOutput (stdout):\n${stdout || '(empty)'}\n${stderr ? 'Errors (stderr):\n' + stderr : ''}\nReview their code and output: confirm if it's correct, point out bugs or better approaches if not, then continue the lesson accordingly.`;
    apiMessages.push({ role: 'user', content: instruction });

    const reply = await respond(req, res, lesson, course, apiMessages);
    await saveMessage(req.user.id, lesson.id, 'user', instruction);
    await saveMessage(req.user.id, lesson.id, 'assistant', reply);
    res.json({ reply });
  } catch (e) {
    res.status(502).json({ error: 'The tutor could not respond: ' + e.message });
  }
});

module.exports = router;
