# Tutorly — courses taught by an AI tutor

A full-stack app: admins build courses (or paste raw material and let AI draft
the outline), students enroll and are taught interactively by an AI tutor —
explanations, intuition, examples, code, diagrams, and quizzes — inside a
chat-style lesson view.

**Stack:** Node.js + Express, PostgreSQL (via plain `pg`, no ORM/native
binaries to fight with), JWT auth, Groq's free LLM API for the tutor, a small
vanilla-JS frontend served as static files by the same server.

---

## 1. Run it locally

### Prerequisites
- Node.js 18+
- A PostgreSQL database — easiest is a free one from [Neon](https://neon.tech)
  or [Render](https://render.com); you can also run Postgres locally if you
  prefer.
- A free Groq API key from [console.groq.com](https://console.groq.com) (no credit card required)

### Steps
```bash
npm install
cp .env.example .env
# now edit .env: paste in your DATABASE_URL, a random JWT_SECRET, and your GROQ_API_KEY

npm run migrate   # creates all tables
npm run seed       # creates a demo admin + student + one sample course

npm run dev         # starts the server with auto-reload on http://localhost:3000
```

Open `http://localhost:3000` in your browser. Demo logins (created by `npm run seed`):
- **Admin:** `admin@tutorly.dev` / `admin123`
- **Student:** `student@tutorly.dev` / `student123`

Or sign up your own account from the login screen (choose "I'm an admin" or
"I'm a student").

### Try the whole flow
1. Log in as admin → create a course → add a module → add a lesson (paste
   some notes, or upload a `.txt`/`.md`/`.pdf` file to pull the text in) →
   Publish.
2. Or click **"Generate outline with AI"**, paste a big chunk of raw material,
   and review the proposed modules/lessons before saving them.
3. Log out, sign up as a student, enroll in the course, open a lesson, and
   chat with the tutor.

---

## 2. Deploy it for real (Render, free tier)

This gets you a real public URL. Railway, Fly.io, and Vercel+external DB work
similarly — the steps below are Render-specific since it has a generous free
tier for both the web service and Postgres.

### Step 1 — Push this project to GitHub
```bash
git init
git add .
git commit -m "Initial commit"
```
Create a new (empty) repo on GitHub, then:
```bash
git remote add origin https://github.com/<you>/<repo>.git
git branch -M main
git push -u origin main
```

### Step 2 — Create a Postgres database on Render
1. Go to [render.com](https://render.com) → New → PostgreSQL.
2. Give it a name, pick the free plan, create it.
3. Once it's up, copy the **"Internal Database URL"** (or "External" if
   connecting from outside Render) — you'll need it in Step 3.

> Render's free Postgres is deleted after 30 days of inactivity, and free
> instances sleep after inactivity too. Fine for a demo; upgrade the plans
> for anything real.

### Step 3 — Create the web service
1. Render dashboard → New → Web Service → connect your GitHub repo.
2. **Build command:** `npm install`
3. **Start command:** `npm run migrate && npm run seed && npm start`
   (the seed step is idempotent — safe to leave in, or drop it after the
   first deploy if you don't want the demo accounts.)
4. Add environment variables under "Environment":
   - `DATABASE_URL` → the Postgres URL from Step 2
   - `JWT_SECRET` → any long random string
   - `GROQ_API_KEY` → your free key from console.groq.com
   - `PORT` → Render sets this automatically; you don't need to add it.
5. Click **Create Web Service**. Render will build and deploy it, then give
   you a URL like `https://tutorly-xyz.onrender.com` — that's your real,
   publicly reachable app.

### Step 4 — Verify
Visit the Render URL, log in with the seeded demo accounts (or sign up), and
run through the same flow as the local test above.

---

## Project structure
```
src/
  server.js           Express app + static file serving
  db.js               pg connection pool + id helper
  middleware/auth.js  JWT auth + admin-only guard
  routes/auth.js      signup / login
  routes/courses.js   course + module + lesson CRUD, AI outline generation
  routes/enrollments.js  enroll, progress tracking
  routes/tutor.js     the AI tutor chat endpoint (system prompt lives here)
  routes/uploads.js   file upload -> extracted text (txt/md/pdf)
  utils/llm.js        thin wrapper around Groq's OpenAI-compatible API
db/schema.sql         full Postgres schema
scripts/migrate.js    runs schema.sql against DATABASE_URL
scripts/seed.js       demo admin/student/course
public/               the frontend (plain HTML/CSS/JS, no build step)
```

## What's new: structured teaching, student memory, live code

**Topic-by-topic teaching.** Each lesson can have an ordered checklist of
topics (chapter → lesson → topic). In the admin lesson editor, click
"Generate with AI" to draft a checklist from the lesson content, or type
one topic per line yourself. The tutor teaches the checklist in order and
won't move on until a topic is "practiced" or "mastered" — the student sees
live progress in a sidebar next to the chat.

**Per-student memory.** Every student has a profile (a level, plus a short
running note the tutor maintains about how they learn) that persists
*across every course they take* — not just within one lesson. The tutor
updates this itself as it teaches, via a hidden instruction embedded at the
end of each of its replies (stripped out before the student ever sees it).
This is what lets the tutor adapt pacing and style to a specific student
over time, not just react to the current message.

**Live, runnable code.** When a lesson calls for it, the tutor can hand the
student a coding exercise with a real editor. Code actually executes —
Python via [Pyodide](https://pyodide.org) (a full CPython interpreter
compiled to WebAssembly) and JavaScript via a sandboxed Web Worker — both
entirely in the student's browser. Nothing is sent to your server to be
executed, which sidesteps the security risk of running untrusted code
server-side, and it costs you nothing no matter how much students use it.
After running, the code and its real output are sent back to the tutor,
which reviews it and gives feedback.

Caveats on this part: only Python and JavaScript are supported (no
external packages beyond what each runtime ships with); the first Python
run in a session takes ~5-10 seconds to load the interpreter; and a
runaway infinite loop is caught by a 12-second timeout that resets the
sandbox, but will briefly look "stuck" until then.

## Notes / honest limitations
- No code execution sandbox: code blocks the tutor writes are shown, not run.
- File upload extraction is basic (plain text read, or `pdf-parse` for PDFs) —
  no OCR for scanned/image-based PDFs.
- The AI outline generator and tutor chat both call the Groq API
  server-side using your `GROQ_API_KEY`; keep that key secret and never
  put it in the frontend.
- Groq's free tier is generous but rate-limited (requests/minute and
  tokens/minute caps that vary by model). If you hit a rate limit or a
  model gets retired, change `GROQ_MODEL` in your `.env` — no code changes
  needed. Current free models are listed at
  [console.groq.com/docs/models](https://console.groq.com/docs/models).
- Passwords are hashed with bcrypt; sessions are JWTs valid for 30 days
  stored in `localStorage` client-side — fine for a project like this, but if
  you need stricter session control, swap to httpOnly cookies.
