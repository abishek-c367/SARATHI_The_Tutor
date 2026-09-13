/* =========================================================================
   API HELPER
========================================================================= */
function getToken(){ return localStorage.getItem('tutorly_token'); }
function setToken(t){ if(t) localStorage.setItem('tutorly_token', t); else localStorage.removeItem('tutorly_token'); }
function getStoredUser(){ try{ return JSON.parse(localStorage.getItem('tutorly_user')); }catch(e){ return null; } }
function setStoredUser(u){ if(u) localStorage.setItem('tutorly_user', JSON.stringify(u)); else localStorage.removeItem('tutorly_user'); }

async function api(path, opts){
  opts = opts || {};
  const headers = Object.assign({'Content-Type':'application/json'}, opts.headers||{});
  const token = getToken();
  if(token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch('/api'+path, {
    method: opts.method||'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try{ data = await res.json(); }catch(e){}
  if(!res.ok){
    if(res.status === 401){ setToken(null); setStoredUser(null); state.user = null; state.view = 'auth'; render(); }
    throw new Error(data.error || ('Request failed (' + res.status + ')'));
  }
  return data;
}

/* =========================================================================
   APP STATE
========================================================================= */
const state = {
  user: getStoredUser(),
  view: getStoredUser() ? (getStoredUser().role==='ADMIN' ? 'adminHome' : 'studentHome') : 'auth',
  courseId: null,
  lessonId: null,
  chat: [],
  busy: false,
  toast: null,
};
function setState(patch){ Object.assign(state, patch); render(); }
function showToast(msg){ state.toast = msg; render(); setTimeout(()=>{ state.toast=null; render(); }, 2600); }
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/* =========================================================================
   MINI MARKDOWN + RICH CONTENT RENDERER (same conventions as the tutor's system prompt)
========================================================================= */
function mdInline(s){
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}
function mdBlock(text){
  const lines = text.split('\n');
  let html = ''; let inList = false;
  for(let raw of lines){
    const line = raw.trimEnd();
    if(/^###\s+/.test(line)){ if(inList){html+='</ul>';inList=false;} html += '<h3>'+mdInline(line.replace(/^###\s+/,''))+'</h3>'; continue; }
    if(/^##\s+/.test(line)){ if(inList){html+='</ul>';inList=false;} html += '<h2>'+mdInline(line.replace(/^##\s+/,''))+'</h2>'; continue; }
    if(/^[-*]\s+/.test(line)){ if(!inList){html+='<ul>';inList=true;} html += '<li>'+mdInline(line.replace(/^[-*]\s+/,''))+'</li>'; continue; }
    if(inList && line.trim()===''){ html+='</ul>'; inList=false; continue; }
    if(line.trim()===''){ continue; }
    if(inList){ html+='</ul>'; inList=false; }
    html += '<p>'+mdInline(line)+'</p>';
  }
  if(inList) html+='</ul>';
  return html;
}
let diagramCounter = 0;
function renderRich(text){
  const parts = text.split(/```(\w+)?\n([\s\S]*?)```/g);
  let html = '';
  const pending = [];
  for(let i=0;i<parts.length;i+=3){
    const plain = parts[i] || '';
    if(plain.trim()) html += mdBlock(plain);
    const lang = parts[i+1];
    const code = parts[i+2];
    if(code === undefined) continue;
    if(lang === 'quiz'){
      html += renderQuizBlock(code);
    } else if(lang === 'mermaid'){
      const id = 'mmd_' + (++diagramCounter);
      pending.push({id, code});
      html += '<div class="diagram-box"><div id="'+id+'">Rendering diagram&hellip;</div></div>';
    } else {
      html += '<pre><code>'+escapeHtml(code.trim())+'</code></pre>';
    }
  }
  return {html, pending};
}
let quizCounter = 0;
const quizRegistry = {};
function renderQuizBlock(jsonStr){
  let q;
  try{ q = JSON.parse(jsonStr.trim()); } catch(e){ return '<div class="quiz-box">Could not load quiz.</div>'; }
  const qid = 'quiz_' + (++quizCounter);
  quizRegistry[qid] = q;
  let optsHtml = '';
  (q.options||[]).forEach((opt, idx)=>{
    optsHtml += '<button class="quiz-opt" onclick="answerQuiz(\''+qid+'\','+idx+')">'+escapeHtml(opt)+'</button>';
  });
  return '<div class="quiz-box" id="'+qid+'_box"><div class="quiz-q">'+escapeHtml(q.question||'Question')+'</div>'+optsHtml+'</div>';
}
function renderPendingDiagrams(pending){
  if(!pending || !pending.length || !window.mermaid) return;
  pending.forEach(async ({id, code})=>{
    try{
      const el = document.getElementById(id);
      if(!el) return;
      const {svg} = await window.mermaid.render(id+'_svg', code.trim());
      el.innerHTML = svg;
    }catch(e){
      const el = document.getElementById(id);
      if(el) el.innerHTML = '<em style="color:#8a4b3c">Diagram could not be rendered.</em>';
    }
  });
}
if(window.mermaid){ window.mermaid.initialize({ startOnLoad:false, theme:'default' }); }

window.answerQuiz = async function(qid, idx){
  const q = quizRegistry[qid];
  if(!q) return;
  const box = document.getElementById(qid+'_box');
  const buttons = box.querySelectorAll('.quiz-opt');
  buttons.forEach((b,i)=>{
    b.disabled = true;
    if(i===q.correctIndex) b.classList.add('correct');
    else if(i===idx) b.classList.add('wrong');
  });
  const explain = document.createElement('div');
  explain.className = 'quiz-explain';
  explain.textContent = q.explanation || '';
  box.appendChild(explain);
  const correct = idx === q.correctIndex;
  setBusy(true); renderChatMessages();
  try{
    const { reply } = await api('/tutor/lessons/'+state.lessonId+'/quiz-result', {
      method:'POST', body:{ chosenText: q.options[idx], correct }
    });
    state.chat.push({ role:'assistant', content: reply });
  }catch(e){
    state.chat.push({ role:'assistant', content: '_Could not reach the tutor: '+e.message+'_' });
  }
  setBusy(false); renderChatMessages();
};

/* =========================================================================
   RENDER ROOT
========================================================================= */
function render(){
  const app = document.getElementById('app');
  if(state.view === 'auth'){ app.innerHTML = renderAuthHtml(); attachAuthEvents(); return; }
  app.innerHTML = renderShellHtml();
  attachShellEvents();
}

/* ---------------- AUTH ---------------- */
let authRole = 'STUDENT';
let authMode = 'login'; // login | signup
function renderAuthHtml(){
  return `
  <div class="auth-screen">
    <div class="auth-card">
      <div class="brand" style="margin-bottom:20px;"><div class="brand-mark">T</div><div class="brand-name">Tutorly</div></div>
      <h1>${authMode==='login' ? 'Log in' : 'Create your account'}</h1>
      <p class="auth-sub">Courses taught interactively by an AI tutor.</p>
      ${authMode==='signup' ? `
        <div class="role-toggle">
          <div class="role-opt ${authRole==='STUDENT'?'active':''}" id="roleStudent">I'm a student</div>
          <div class="role-opt ${authRole==='ADMIN'?'active':''}" id="roleAdmin">I'm an admin</div>
        </div>
        <div class="field"><label>Your name</label><input id="nameInput" placeholder="e.g. Priya Sharma" autocomplete="off" /></div>
      ` : ''}
      <div class="field"><label>Email</label><input id="emailInput" type="email" placeholder="you@example.com" autocomplete="username" /></div>
      <div class="field"><label>Password</label><input id="passInput" type="password" placeholder="${authMode==='signup' ? 'At least 6 characters' : ''}" autocomplete="current-password" /></div>
      <div id="authError" class="error-text" style="display:none;"></div>
      <button class="btn btn-primary" id="submitBtn" style="width:100%;">${authMode==='login' ? 'Log in' : 'Create account'}</button>
      <p class="mode-toggle">
        ${authMode==='login' ? `New here? <span class="linklike" id="toSignup">Create an account</span>` : `Already have an account? <span class="linklike" id="toLogin">Log in</span>`}
      </p>
      ${authMode==='login' ? `<p class="banner-note" style="margin-top:16px;">Demo logins &mdash; admin: admin@tutorly.dev / admin123 &middot; student: student@tutorly.dev / student123</p>` : ''}
    </div>
  </div>`;
}
function attachAuthEvents(){
  const errEl = document.getElementById('authError');
  const showErr = (msg)=>{ errEl.textContent = msg; errEl.style.display = 'block'; };
  if(authMode==='signup'){
    document.getElementById('roleStudent').onclick = ()=>{ authRole='STUDENT'; render(); };
    document.getElementById('roleAdmin').onclick = ()=>{ authRole='ADMIN'; render(); };
  }
  const toSignup = document.getElementById('toSignup');
  if(toSignup) toSignup.onclick = ()=>{ authMode='signup'; render(); };
  const toLogin = document.getElementById('toLogin');
  if(toLogin) toLogin.onclick = ()=>{ authMode='login'; render(); };

  document.getElementById('submitBtn').onclick = async ()=>{
    const email = document.getElementById('emailInput').value.trim();
    const password = document.getElementById('passInput').value;
    if(!email || !password) return showErr('Enter an email and password.');
    try{
      let data;
      if(authMode==='signup'){
        const name = document.getElementById('nameInput').value.trim();
        if(!name) return showErr('Enter your name.');
        data = await api('/auth/signup', { method:'POST', body:{ name, email, password, role: authRole } });
      } else {
        data = await api('/auth/login', { method:'POST', body:{ email, password } });
      }
      setToken(data.token); setStoredUser(data.user);
      setState({ user: data.user, view: data.user.role==='ADMIN' ? 'adminHome' : 'studentHome' });
    }catch(e){ showErr(e.message); }
  };
}

/* ---------------- SHELL ---------------- */
function renderShellHtml(){
  return `
    <div class="topbar">
      <div class="brand"><div class="brand-mark">T</div><div class="brand-name">Tutorly</div></div>
      <div class="who">
        <span class="pill">${state.user.role.toLowerCase()}</span>
        <span><b>${escapeHtml(state.user.name)}</b></span>
        <button class="linklike" id="logoutBtn">Log out</button>
      </div>
    </div>
    <div class="shell">
      <div class="sidebar" id="sidebarSlot"></div>
      <div class="main" id="mainSlot"><div class="wrap">Loading&hellip;</div></div>
    </div>
    ${state.toast ? '<div class="toast">'+escapeHtml(state.toast)+'</div>' : ''}
  `;
}
function attachShellEvents(){
  document.getElementById('logoutBtn').onclick = ()=>{
    setToken(null); setStoredUser(null);
    setState({ user:null, view:'auth', courseId:null, lessonId:null, chat:[] });
  };
  buildSidebar();
  buildMain();
}
function buildSidebar(){
  const el = document.getElementById('sidebarSlot');
  if(!el) return;
  if(state.user.role === 'ADMIN'){
    el.innerHTML = `
      <div class="side-title">Admin</div>
      <div class="side-item ${state.view==='adminHome'?'active':''}" id="navAdminHome">All courses</div>
      <div class="side-item" id="navNewCourse">+ New course</div>`;
    document.getElementById('navAdminHome').onclick = ()=> setState({view:'adminHome', courseId:null});
    document.getElementById('navNewCourse').onclick = openNewCourseModal;
  } else {
    el.innerHTML = `
      <div class="side-title">Learning</div>
      <div class="side-item ${state.view==='studentHome'?'active':''}" id="navStudentHome">Catalog</div>`;
    document.getElementById('navStudentHome').onclick = ()=> setState({view:'studentHome', courseId:null, lessonId:null});
  }
}
function buildMain(){
  const el = document.getElementById('mainSlot');
  if(!el) return;
  if(state.view === 'adminHome') return renderAdminHome(el);
  if(state.view === 'courseEditor') return renderCourseEditor(el);
  if(state.view === 'studentHome') return renderStudentHome(el);
  if(state.view === 'courseView') return renderCourseView(el);
  if(state.view === 'lesson') return renderLessonView(el);
}

/* ================= ADMIN: course list ================= */
async function renderAdminHome(el){
  let courses = [];
  try{ ({courses} = await api('/courses')); }catch(e){ el.innerHTML = '<div class="wrap">'+escapeHtml(e.message)+'</div>'; return; }
  let cardsHtml = '';
  if(courses.length===0){
    cardsHtml = `<div class="empty"><h3>No courses yet</h3><p>Create your first course to start designing lessons for the AI tutor to teach.</p></div>`;
  } else {
    courses.forEach(c=>{
      const lessonCount = (c.modules||[]).reduce((n,m)=>n+(m.lessons||[]).length,0);
      cardsHtml += `
      <div class="card">
        <div class="card-row">
          <div><p class="card-title">${escapeHtml(c.title)}</p><p class="card-meta">${lessonCount} lesson${lessonCount===1?'':'s'} &middot; ${c.status==='published' ? 'Published' : 'Draft'}</p></div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-sm" onclick="openCourse('${c.id}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="removeCourse('${c.id}')">Delete</button>
          </div>
        </div>
      </div>`;
    });
  }
  el.innerHTML = `
    <div class="wrap">
      <div class="flexbetween">
        <div><h1 class="page-title">Courses</h1><p class="page-sub">Design course structure or paste raw material and let the tutor's co-pilot draft the outline.</p></div>
        <button class="btn btn-primary" onclick="openNewCourseModal()">+ New course</button>
      </div>
      ${cardsHtml}
    </div>`;
}
window.openCourse = (id)=> setState({view:'courseEditor', courseId:id});
window.removeCourse = async (id)=>{
  if(!confirm('Delete this course? This cannot be undone.')) return;
  try{ await api('/courses/'+id, {method:'DELETE'}); render(); }catch(e){ showToast(e.message); }
};

function openNewCourseModal(){
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>New course</h2>
      <div class="field"><label>Title</label><input id="ncTitle" placeholder="e.g. Introduction to Linear Algebra" /></div>
      <div class="field"><label>Description</label><textarea id="ncDesc" rows="3" placeholder="What will students learn?"></textarea></div>
      <div class="modal-actions"><button class="btn" id="ncCancel">Cancel</button><button class="btn btn-primary" id="ncCreate">Create course</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#ncCancel').onclick = ()=> backdrop.remove();
  backdrop.querySelector('#ncCreate').onclick = async ()=>{
    const title = backdrop.querySelector('#ncTitle').value.trim();
    const description = backdrop.querySelector('#ncDesc').value.trim();
    if(!title) return;
    try{
      const { course } = await api('/courses', { method:'POST', body:{ title, description } });
      backdrop.remove();
      setState({ view:'courseEditor', courseId: course.id });
    }catch(e){ showToast(e.message); }
  };
}

/* ================= ADMIN: course editor ================= */
async function renderCourseEditor(el){
  let course;
  try{ ({course} = await api('/courses/'+state.courseId)); }catch(e){ el.innerHTML = '<div class="wrap">'+escapeHtml(e.message)+'</div>'; return; }
  let modulesHtml = '';
  (course.modules||[]).forEach((m)=>{
    let lessonsHtml = '';
    (m.lessons||[]).forEach((l)=>{
      lessonsHtml += `
      <div class="lesson-row">
        <span>${escapeHtml(l.title)}</span>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm" onclick="editLesson('${m.id}','${l.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="removeLesson('${l.id}')">Remove</button>
        </div>
      </div>`;
    });
    modulesHtml += `
    <div class="module-block">
      <div class="module-head">
        <span>${escapeHtml(m.title)}</span>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-sm" onclick="addLesson('${m.id}')">+ Lesson</button>
          <button class="btn btn-sm btn-danger" onclick="removeModule('${m.id}')">Remove module</button>
        </div>
      </div>
      ${lessonsHtml || '<div class="lesson-row" style="color:var(--pale-dim)">No lessons yet.</div>'}
    </div>`;
  });
  el.innerHTML = `
    <div class="wrap">
      <button class="linklike" onclick="setState({view:'adminHome',courseId:null})" style="margin-bottom:14px;">&larr; All courses</button>
      <div class="flexbetween">
        <div><h1 class="page-title">${escapeHtml(course.title)}</h1><p class="page-sub">${escapeHtml(course.description||'')}</p></div>
        <div style="display:flex;gap:8px;">
          <button class="btn" onclick="editCourseMeta()">Edit details</button>
          <button class="btn ${course.status==='published'?'':'btn-primary'}" onclick="togglePublish('${course.status}')">${course.status==='published' ? 'Unpublish' : 'Publish'}</button>
        </div>
      </div>
      <div class="banner-note">${course.status==='published' ? 'Students can enroll and take this course.' : 'This course is a draft &mdash; students cannot see it yet.'}</div>
      <div class="flexbetween" style="margin-top:8px;">
        <h2 class="section-title" style="margin-top:0;">Curriculum</h2>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-sm" onclick="addModule()">+ Module</button>
          <button class="btn btn-sm" onclick="openAiOutlineModal()">Generate outline with AI</button>
        </div>
      </div>
      ${modulesHtml || '<div class="empty"><h3>No modules yet</h3><p>Add a module manually, or paste raw course material and have the AI draft a structured outline for you to review.</p></div>'}
    </div>`;
}
window.editCourseMeta = async ()=>{
  const { course } = await api('/courses/'+state.courseId);
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>Edit course details</h2>
      <div class="field"><label>Title</label><input id="ecTitle" value="${escapeHtml(course.title)}" /></div>
      <div class="field"><label>Description</label><textarea id="ecDesc" rows="3">${escapeHtml(course.description||'')}</textarea></div>
      <div class="modal-actions"><button class="btn" id="ecCancel">Cancel</button><button class="btn btn-primary" id="ecSave">Save</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#ecCancel').onclick = ()=> backdrop.remove();
  backdrop.querySelector('#ecSave').onclick = async ()=>{
    const title = backdrop.querySelector('#ecTitle').value.trim();
    const description = backdrop.querySelector('#ecDesc').value.trim();
    try{ await api('/courses/'+state.courseId, {method:'PATCH', body:{title, description}}); backdrop.remove(); render(); }
    catch(e){ showToast(e.message); }
  };
};
window.togglePublish = async (currentStatus)=>{
  const status = currentStatus==='published' ? 'draft' : 'published';
  try{ await api('/courses/'+state.courseId, {method:'PATCH', body:{status}}); render(); }catch(e){ showToast(e.message); }
};
window.addModule = async ()=>{
  const title = prompt('Module title');
  if(!title) return;
  try{ await api('/courses/'+state.courseId+'/modules', {method:'POST', body:{title}}); render(); }catch(e){ showToast(e.message); }
};
window.removeModule = async (moduleId)=>{
  if(!confirm('Remove this module and all its lessons?')) return;
  try{ await api('/courses/modules/'+moduleId, {method:'DELETE'}); render(); }catch(e){ showToast(e.message); }
};
window.removeLesson = async (lessonId)=>{
  if(!confirm('Remove this lesson?')) return;
  try{ await api('/courses/lessons/'+lessonId, {method:'DELETE'}); render(); }catch(e){ showToast(e.message); }
};
window.addLesson = (moduleId)=> openLessonModal(moduleId, null);
window.editLesson = (moduleId, lessonId)=> openLessonModal(moduleId, lessonId);

async function openLessonModal(moduleId, lessonId){
  let existing = null;
  if(lessonId){
    const { course } = await api('/courses/'+state.courseId);
    const mod = (course.modules||[]).find(m=>m.id===moduleId);
    existing = (mod.lessons||[]).find(l=>l.id===lessonId);
  }
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>${existing ? 'Edit lesson' : 'New lesson'}</h2>
      <div class="field"><label>Lesson title</label><input id="lsTitle" value="${existing?escapeHtml(existing.title):''}" placeholder="e.g. Vectors and vector spaces" /></div>
      <div class="field">
        <label>Source material / notes for the tutor</label>
        <textarea id="lsContent" rows="9" placeholder="Paste the raw content the tutor should teach from, or upload a file below.">${existing?escapeHtml(existing.content):''}</textarea>
      </div>
      <div class="field">
        <label>Or upload a .txt, .md, or .pdf file to extract text from</label>
        <input type="file" id="lsFile" accept=".txt,.md,.pdf" />
        <div id="lsFileStatus" style="font-size:12.5px;color:var(--pale-dim);margin-top:6px;"></div>
      </div>
      <div class="modal-actions"><button class="btn" id="lsCancel">Cancel</button><button class="btn btn-primary" id="lsSave">Save lesson</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#lsCancel').onclick = ()=> backdrop.remove();
  backdrop.querySelector('#lsFile').onchange = async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const statusEl = backdrop.querySelector('#lsFileStatus');
    statusEl.textContent = 'Extracting text\u2026';
    const form = new FormData();
    form.append('file', file);
    try{
      const res = await fetch('/api/uploads/extract', { method:'POST', headers:{ Authorization:'Bearer '+getToken() }, body: form });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Upload failed.');
      backdrop.querySelector('#lsContent').value = data.text;
      statusEl.textContent = 'Extracted ' + data.text.length + ' characters from ' + file.name + '.';
    }catch(err){ statusEl.textContent = 'Error: ' + err.message; }
  };
  backdrop.querySelector('#lsSave').onclick = async ()=>{
    const title = backdrop.querySelector('#lsTitle').value.trim();
    const content = backdrop.querySelector('#lsContent').value.trim();
    if(!title || !content) return;
    try{
      if(existing) await api('/courses/lessons/'+existing.id, {method:'PATCH', body:{title, content}});
      else await api('/courses/modules/'+moduleId+'/lessons', {method:'POST', body:{title, content}});
      backdrop.remove();
      render();
    }catch(e){ showToast(e.message); }
  };
}

/* ---- AI-assisted outline generation ---- */
function openAiOutlineModal(){
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h2>Generate outline with AI</h2>
      <p class="page-sub" style="margin-bottom:12px;">Paste raw course material. The tutor's co-pilot will propose modules and lessons for you to review &mdash; nothing is saved until you approve it.</p>
      <div class="field"><textarea id="rawMaterial" rows="9" placeholder="Paste raw material here&hellip;"></textarea></div>
      <div class="field">
        <label>Or upload a .txt, .md, or .pdf file</label>
        <input type="file" id="aoFile" accept=".txt,.md,.pdf" />
      </div>
      <div class="modal-actions"><button class="btn" id="aoCancel">Cancel</button><button class="btn btn-primary" id="aoGenerate">Generate outline</button></div>
      <div id="aoStatus" style="margin-top:10px;font-size:13px;color:var(--pale-dim);"></div>
      <div id="aoPreview"></div>
    </div>`;
  document.body.appendChild(backdrop);
  backdrop.querySelector('#aoCancel').onclick = ()=> backdrop.remove();
  backdrop.querySelector('#aoFile').onchange = async (e)=>{
    const file = e.target.files[0];
    if(!file) return;
    const form = new FormData();
    form.append('file', file);
    const statusEl = backdrop.querySelector('#aoStatus');
    statusEl.textContent = 'Extracting text\u2026';
    try{
      const res = await fetch('/api/uploads/extract', { method:'POST', headers:{ Authorization:'Bearer '+getToken() }, body: form });
      const data = await res.json();
      if(!res.ok) throw new Error(data.error || 'Upload failed.');
      backdrop.querySelector('#rawMaterial').value = data.text;
      statusEl.textContent = 'Extracted text from ' + file.name + '. Click Generate outline.';
    }catch(err){ statusEl.textContent = 'Error: ' + err.message; }
  };
  backdrop.querySelector('#aoGenerate').onclick = async ()=>{
    const rawText = backdrop.querySelector('#rawMaterial').value.trim();
    if(!rawText) return;
    const statusEl = backdrop.querySelector('#aoStatus');
    statusEl.textContent = 'Drafting outline\u2026';
    backdrop.querySelector('#aoGenerate').disabled = true;
    try{
      const { outline } = await api('/courses/'+state.courseId+'/generate-outline', { method:'POST', body:{rawText} });
      statusEl.textContent = 'Review the proposed outline below, then save it.';
      let preview = '';
      outline.modules.forEach(m=>{
        preview += '<div class="module-block"><div class="module-head"><span>'+escapeHtml(m.title)+'</span></div>';
        (m.lessons||[]).forEach(l=> preview += '<div class="lesson-row"><span>'+escapeHtml(l.title)+'</span></div>');
        preview += '</div>';
      });
      backdrop.querySelector('#aoPreview').innerHTML = preview + '<button class="btn btn-primary" id="aoSave" style="margin-top:10px;">Save this outline to the course</button>';
      backdrop.querySelector('#aoSave').onclick = async ()=>{
        try{
          await api('/courses/'+state.courseId+'/apply-outline', { method:'POST', body:{outline} });
          backdrop.remove();
          showToast('Outline added \u2014 review and edit each lesson before publishing.');
          render();
        }catch(e){ showToast(e.message); }
      };
    }catch(e){
      statusEl.textContent = 'Could not generate an outline (' + e.message + ').';
    }
    backdrop.querySelector('#aoGenerate').disabled = false;
  };
}

/* ================= STUDENT: catalog ================= */
async function renderStudentHome(el){
  let courses = [], courseIds = [];
  try{
    ({courses} = await api('/courses'));
    ({courseIds} = await api('/enrollments/mine'));
  }catch(e){ el.innerHTML = '<div class="wrap">'+escapeHtml(e.message)+'</div>'; return; }
  let html = '';
  if(courses.length===0){
    html = `<div class="empty"><h3>No courses available yet</h3><p>Check back once an admin publishes a course.</p></div>`;
  } else {
    for(const c of courses){
      const lessonCount = (c.modules||[]).reduce((n,m)=>n+(m.lessons||[]).length,0);
      const isEnrolled = courseIds.includes(c.id);
      let pct = 0;
      if(isEnrolled){
        try{
          const { progress } = await api('/enrollments/'+c.id+'/progress');
          const done = Object.values(progress).filter(p=>p.status==='completed').length;
          pct = lessonCount ? Math.round(100*done/lessonCount) : 0;
        }catch(e){}
      }
      html += `
      <div class="card">
        <div class="card-row">
          <div style="flex:1;">
            <p class="card-title">${escapeHtml(c.title)}</p>
            <p class="card-meta">${escapeHtml(c.description||'')}</p>
            <p class="card-meta">${lessonCount} lesson${lessonCount===1?'':'s'}</p>
            ${isEnrolled ? `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>` : ''}
          </div>
          <button class="btn ${isEnrolled?'':'btn-primary'}" onclick="${isEnrolled ? `openStudentCourse('${c.id}')` : `enrollAndOpen('${c.id}')`}">${isEnrolled ? 'Continue' : 'Enroll'}</button>
        </div>
      </div>`;
    }
  }
  el.innerHTML = `<div class="wrap"><h1 class="page-title">Course catalog</h1><p class="page-sub">Pick a course. The AI tutor adapts to your pace &mdash; ask it anything as you go.</p>${html}</div>`;
}
window.enrollAndOpen = async (courseId)=>{
  try{ await api('/enrollments', {method:'POST', body:{courseId}}); setState({view:'courseView', courseId}); }
  catch(e){ showToast(e.message); }
};
window.openStudentCourse = (courseId)=> setState({view:'courseView', courseId});

/* ================= STUDENT: course view (lesson list) ================= */
async function renderCourseView(el){
  let course, progress = {};
  try{
    ({course} = await api('/courses/'+state.courseId));
    ({progress} = await api('/enrollments/'+state.courseId+'/progress'));
  }catch(e){ el.innerHTML = '<div class="wrap">'+escapeHtml(e.message)+'</div>'; return; }
  let modulesHtml = '';
  (course.modules||[]).forEach(m=>{
    let lessonsHtml = '';
    (m.lessons||[]).forEach(l=>{
      const st = progress[l.id]?.status || 'not_started';
      const cls = st==='completed' ? 'done' : (st==='in_progress' ? 'current' : '');
      const label = st==='completed' ? 'Review' : (st==='in_progress' ? 'Resume' : 'Start');
      lessonsHtml += `
      <div class="lesson-row">
        <div class="lesson-left"><span class="lesson-status ${cls}"></span><span>${escapeHtml(l.title)}</span></div>
        <button class="btn btn-sm" onclick="openLessonView('${l.id}')">${label}</button>
      </div>`;
    });
    modulesHtml += `<div class="module-block"><div class="module-head"><span>${escapeHtml(m.title)}</span></div>${lessonsHtml}</div>`;
  });
  el.innerHTML = `
    <div class="wrap">
      <button class="linklike" onclick="setState({view:'studentHome',courseId:null})" style="margin-bottom:14px;">&larr; Catalog</button>
      <h1 class="page-title">${escapeHtml(course.title)}</h1>
      <p class="page-sub">${escapeHtml(course.description||'')}</p>
      <h2 class="section-title">Lessons</h2>
      ${modulesHtml || '<div class="empty">This course has no lessons yet.</div>'}
    </div>`;
}
window.openLessonView = (lessonId)=> setState({view:'lesson', lessonId, chat:[]});

/* ================= STUDENT: lesson / tutor chat ================= */
async function renderLessonView(el){
  let course, lesson;
  try{
    ({course} = await api('/courses/'+state.courseId));
    for(const m of course.modules){ const l = m.lessons.find(x=>x.id===state.lessonId); if(l){ lesson=l; break; } }
  }catch(e){ el.innerHTML = '<div class="wrap">'+escapeHtml(e.message)+'</div>'; return; }
  if(!lesson){ el.innerHTML = '<div class="wrap">Lesson not found.</div>'; return; }

  el.innerHTML = `
    <div class="tutor-shell" style="height:calc(100vh - 65px);margin:-32px -40px;">
      <div class="tutor-head">
        <div>
          <button class="linklike" onclick="setState({view:'courseView', lessonId:null, chat:[]})">&larr; ${escapeHtml(course.title)}</button>
          <h2 style="margin:2px 0 0;font-size:17px;">${escapeHtml(lesson.title)}</h2>
        </div>
        <button class="btn btn-sm" onclick="markCompleteManually()">Mark as complete</button>
      </div>
      <div class="tutor-body" id="tutorBody"><div class="tutor-inner" id="tutorInner"></div></div>
      <div class="tutor-input">
        <div class="tutor-input-inner">
          <textarea id="chatInput" placeholder="Ask a question, or send a blank message to begin&hellip;" rows="1"></textarea>
          <button class="btn btn-primary" id="sendBtn">Send</button>
        </div>
      </div>
    </div>`;

  document.getElementById('sendBtn').onclick = handleSend;
  document.getElementById('chatInput').addEventListener('keydown', e=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); handleSend(); }
  });

  let messages = [];
  try{ ({messages} = await api('/tutor/lessons/'+state.lessonId+'/messages')); }catch(e){}
  state.chat = messages
    .filter(m=>!(m.role==='user' && m.content.startsWith('[Quiz answered]')))
    .map(m=>({role:m.role, content:m.content}));
  renderChatMessages();

  if(messages.length === 0){
    setBusy(true); renderChatMessages();
    try{
      const { reply } = await api('/tutor/lessons/'+state.lessonId+'/messages', { method:'POST', body:{ begin:true } });
      state.chat.push({ role:'assistant', content: reply });
    }catch(e){
      state.chat.push({ role:'assistant', content: '_The tutor could not start the lesson: '+e.message+'_' });
    }
    setBusy(false); renderChatMessages();
  }
}

function setBusy(v){ state.busy = v; }

function renderChatMessages(){
  const inner = document.getElementById('tutorInner');
  if(!inner) return;
  let html = '';
  let allPending = [];
  state.chat.forEach(m=>{
    if(m.role === 'user'){
      html += `<div class="msg-row user"><div class="bubble-user">${mdInline(m.content)}</div></div>`;
    } else {
      const {html:rich, pending} = renderRich(m.content);
      allPending = allPending.concat(pending);
      html += `<div class="msg-row"><div class="bubble-tutor">${rich}</div></div>`;
    }
  });
  if(state.busy){
    html += `<div class="msg-row"><div class="bubble-tutor thinking"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div></div>`;
  }
  inner.innerHTML = html;
  const body = document.getElementById('tutorBody');
  if(body) body.scrollTop = body.scrollHeight + 999;
  renderPendingDiagrams(allPending);
}

async function handleSend(){
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if(!text || state.busy) return;
  input.value = '';
  state.chat.push({ role:'user', content:text });
  setBusy(true); renderChatMessages();
  try{
    const { reply } = await api('/tutor/lessons/'+state.lessonId+'/messages', { method:'POST', body:{ message:text } });
    state.chat.push({ role:'assistant', content: reply });
  }catch(e){
    state.chat.push({ role:'assistant', content: '_The tutor hit a problem: '+e.message+'_' });
  }
  setBusy(false); renderChatMessages();
}

window.markCompleteManually = async ()=>{
  try{ await api('/enrollments/lessons/'+state.lessonId+'/progress', {method:'POST', body:{status:'completed'}}); showToast('Marked complete.'); }
  catch(e){ showToast(e.message); }
};

window.setState = setState;
window.openLessonView = openLessonView;

render();
