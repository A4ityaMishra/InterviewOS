const GENERAL_JOB_ID = "general"; // matches server/applications.py's GENERAL_JOB_ID sentinel
function roleLabel(jobId, posting) {
  if (jobId === GENERAL_JOB_ID) return "General application";
  return posting ? posting.role : "Unknown role";
}

const AV_GRADIENTS = [
  ["#6366f1", "#4338ca"], ["#10b981", "#047857"], ["#f97316", "#c2410c"],
  ["#8b5cf6", "#6d28d9"], ["#ec4899", "#be185d"], ["#0ea5e9", "#0369a1"],
];
function avStyle(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = AV_GRADIENTS[h % AV_GRADIENTS.length];
  return `background: linear-gradient(135deg, ${a}, ${b})`;
}
function initials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";
}
const fmtTime = ts => ts ? new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

const toastStack = document.getElementById("toast-stack");
function showToast(message, type = "error") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastStack.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  }, 4000);
}

// ---------- user chip / auth ----------
async function loadMe() {
  const resp = await fetch("/api/auth/me");
  if (resp.status === 401) { window.location.href = "/login"; return; }
  const user = await resp.json();
  document.getElementById("chip-name").textContent = user.name;
  const av = document.getElementById("chip-av");
  av.textContent = initials(user.name);
  av.style = avStyle(user.name);
  document.getElementById("user-chip").hidden = false;
  if (user.is_admin) document.getElementById("nav-team").hidden = false;
}
document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
});

// ---------- change password ----------
const pwScrim = document.getElementById("pw-scrim");
const pwForm = document.getElementById("pw-form");
const pwErr = document.getElementById("pw-err");
const pwSuccess = document.getElementById("pw-success");
const pwSubmit = document.getElementById("pw-submit");
document.getElementById("change-pw-btn").addEventListener("click", () => {
  pwForm.reset(); pwForm.hidden = false; pwErr.hidden = true; pwSuccess.hidden = true; pwScrim.hidden = false;
});
document.getElementById("pw-cancel").addEventListener("click", () => { pwScrim.hidden = true; });
pwScrim.addEventListener("click", (e) => { if (e.target === pwScrim) pwScrim.hidden = true; });
pwForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  pwErr.hidden = true;
  const fd = new FormData(pwForm);
  const newPassword = fd.get("new_password");
  if (newPassword !== fd.get("confirm_password")) {
    pwErr.textContent = "New password and confirmation don't match.";
    pwErr.hidden = false;
    return;
  }
  pwSubmit.disabled = true; pwSubmit.textContent = "Updating…";
  try {
    const resp = await fetch("/api/auth/change-password", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: fd.get("current_password"), new_password: newPassword }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      pwErr.textContent = body.detail || "Could not update your password.";
      pwErr.hidden = false;
      return;
    }
    pwForm.hidden = true; pwSuccess.hidden = false;
  } finally {
    pwSubmit.disabled = false; pwSubmit.textContent = "Update password";
  }
});

// ---------- state ----------
let activeTab = "applications"; // applications | postings
let applications = [];
let postings = [];
let postingsById = {};
let statusFilter = "all";
let searchQuery = "";
let selectedId = null;

const shell = document.getElementById("shell");
const listEl = document.getElementById("list");
const detailEl = document.getElementById("detail");
const viewTitle = document.getElementById("view-title");
const viewMeta = document.getElementById("view-meta");
const viewStatus = document.getElementById("view-status");
const viewAv = document.getElementById("view-av");
const appStats = document.getElementById("app-stats");
const newPostingBtn = document.getElementById("new-posting-btn");
const filterInput = document.getElementById("filter");

document.getElementById("tab-applications").addEventListener("click", () => switchTab("applications"));
document.getElementById("tab-postings").addEventListener("click", () => switchTab("postings"));

function switchTab(tab) {
  activeTab = tab;
  selectedId = null;
  document.getElementById("tab-applications").classList.toggle("active", tab === "applications");
  document.getElementById("tab-postings").classList.toggle("active", tab === "postings");
  appStats.hidden = tab !== "applications";
  newPostingBtn.hidden = tab !== "postings";
  statusFilter = "all";
  filterInput.value = "";
  searchQuery = "";
  showPlaceholder();
  render();
}

function showPlaceholder() {
  shell.classList.remove("viewing");
  viewTitle.textContent = "Select an item";
  viewMeta.textContent = "";
  viewStatus.hidden = true;
  viewAv.hidden = true;
  detailEl.innerHTML = `
    <div class="placeholder">
      <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <div>Pick an item on the left to review it.</div>
    </div>`;
}

document.getElementById("back").addEventListener("click", () => { selectedId = null; showPlaceholder(); });

appStats.querySelectorAll(".stat").forEach((el) => {
  el.addEventListener("click", () => {
    statusFilter = el.dataset.filter;
    appStats.querySelectorAll(".stat").forEach((t) => {
      const active = t === el;
      t.classList.toggle("active", active);
      t.setAttribute("aria-checked", active ? "true" : "false");
    });
    render();
  });
});

filterInput.addEventListener("input", () => { searchQuery = filterInput.value.trim().toLowerCase(); render(); });

async function loadAll() {
  const [appsResp, postingsResp] = await Promise.all([
    fetch("/api/applications"),
    fetch("/api/postings"),
  ]);
  if (appsResp.status === 403 || postingsResp.status === 403) { window.location.href = "/welcome"; return; }
  applications = await appsResp.json();
  postings = await postingsResp.json();
  postingsById = Object.fromEntries(postings.map(p => [p.id, p]));
  render();
}

function render() {
  if (activeTab === "applications") renderApplications();
  else renderPostings();
}

function renderApplications() {
  document.getElementById("st-pending").textContent = applications.filter(a => a.status === "pending").length;
  document.getElementById("st-approved").textContent = applications.filter(a => a.status === "approved").length;
  document.getElementById("st-rejected").textContent = applications.filter(a => a.status === "rejected").length;

  let items = applications.filter(a => statusFilter === "all" || a.status === statusFilter);
  if (searchQuery) {
    items = items.filter(a =>
      a.applicant_name.toLowerCase().includes(searchQuery) ||
      a.applicant_email.toLowerCase().includes(searchQuery) ||
      roleLabel(a.job_id, postingsById[a.job_id]).toLowerCase().includes(searchQuery)
    );
  }
  items = items.slice().sort((a, b) => b.created_at - a.created_at);

  listEl.innerHTML = "";
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">No applications match this filter.</div>`;
    return;
  }
  items.forEach((a, i) => {
    const posting = postingsById[a.job_id];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "item" + (a.id === selectedId ? " active" : "");
    row.style.animationDelay = `${Math.min(i, 8) * 0.03}s`;
    row.innerHTML = `
      <div class="av"></div>
      <div class="info">
        <div class="role"></div>
        <div class="meta"><span></span></div>
      </div>
      <span class="badge ${a.status === "approved" ? "completed" : a.status === "rejected" ? "disconnected" : "created"}"></span>`;
    row.querySelector(".av").style = avStyle(a.applicant_name);
    row.querySelector(".av").textContent = initials(a.applicant_name);
    row.querySelector(".role").textContent = a.applicant_name;
    row.querySelector(".meta span").textContent = `${roleLabel(a.job_id, posting)} · ${fmtTime(a.created_at)}`;
    row.querySelector(".badge").textContent = a.status;
    row.onclick = () => selectApplication(a.id);
    listEl.appendChild(row);
  });
}

function selectApplication(id) {
  selectedId = id;
  const a = applications.find(x => x.id === id);
  if (!a) return;
  shell.classList.add("viewing");
  renderApplications();
  const posting = postingsById[a.job_id];
  viewAv.hidden = false;
  viewAv.textContent = initials(a.applicant_name);
  viewAv.style = avStyle(a.applicant_name);
  viewTitle.textContent = a.applicant_name;
  viewMeta.textContent = `Applied ${fmtTime(a.created_at)}`;
  viewStatus.hidden = false;
  viewStatus.className = `badge ${a.status === "approved" ? "completed" : a.status === "rejected" ? "disconnected" : "created"}`;
  viewStatus.textContent = a.status;

  const actions = a.status === "pending"
    ? `<div class="detail-actions">
         <button class="btn-secondary" id="act-reject" style="flex:1;">Reject</button>
         <button class="btn-primary" id="act-approve" style="flex:1;">Approve</button>
       </div>`
    : a.status === "approved" && a.session_id
      ? `<div class="review-row"><span class="k">Interview</span><span class="v">Scheduled (${a.session_id.slice(0, 8)})</span></div>`
      : a.status === "approved" && a.job_id !== GENERAL_JOB_ID
        ? `<div class="review-row"><span class="k">Interview</span><span class="v muted">Not yet scheduled — use Ops Dashboard → Schedule from application</span></div>`
        : a.status === "approved"
          ? `<div class="review-row"><span class="k">Interview</span><span class="v muted">General application — no posting to prefill from, create a session manually via Ops → New Interview when ready</span></div>`
          : a.rejection_reason
            ? `<div class="review-row"><span class="k">Reason</span><span class="v">${a.rejection_reason}</span></div>`
            : "";

  detailEl.innerHTML = `
    <div class="review-list">
      <div class="review-row"><span class="k">Applying for</span><span class="v">${roleLabel(a.job_id, posting)}</span></div>
      <div class="review-row"><span class="k">Email</span><span class="v">${a.applicant_email}</span></div>
      <div class="review-row"><span class="k">Phone</span><span class="v ${a.applicant_phone ? "" : "muted"}">${a.applicant_phone || "Not provided"}</span></div>
      <div class="review-row"><span class="k">Reviewed by</span><span class="v ${a.reviewed_by ? "" : "muted"}">${a.reviewed_by || "Not yet reviewed"}</span></div>
    </div>
    ${a.cover_note ? `<div class="sub" style="margin-bottom:8px;">Cover note</div><div class="jd-viewer scrollable">${a.cover_note}</div>` : ""}
    <div class="sub" style="margin-bottom:8px;">Resume</div>
    <div class="jd-viewer scrollable">${a.resume_text || "—"}</div>
    ${actions}`;

  const approveBtn = document.getElementById("act-approve");
  const rejectBtn = document.getElementById("act-reject");
  if (approveBtn) approveBtn.onclick = () => approveApplication(a.id);
  if (rejectBtn) rejectBtn.onclick = () => openRejectModal(a.id);
}

async function approveApplication(id) {
  const resp = await fetch(`/api/applications/${id}/approve`, { method: "POST" });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    showToast(body.detail || "Could not approve this application.");
    return;
  }
  showToast("Application approved.", "success");
  await loadAll();
  selectApplication(id);
}

const rejectScrim = document.getElementById("reject-scrim");
const rejectForm = document.getElementById("reject-form");
let rejectingId = null;
function openRejectModal(id) { rejectingId = id; rejectForm.reset(); rejectScrim.hidden = false; }
document.getElementById("reject-cancel").onclick = () => { rejectScrim.hidden = true; };
rejectScrim.addEventListener("click", (e) => { if (e.target === rejectScrim) rejectScrim.hidden = true; });
rejectForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fd = new FormData(rejectForm);
  const resp = await fetch(`/api/applications/${rejectingId}/reject`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: fd.get("reason") || "" }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    showToast(body.detail || "Could not reject this application.");
    return;
  }
  rejectScrim.hidden = true;
  showToast("Application rejected.", "success");
  const id = rejectingId;
  await loadAll();
  selectApplication(id);
});

// ---------- postings tab ----------
function renderPostings() {
  let items = postings.slice();
  if (searchQuery) items = items.filter(p => p.role.toLowerCase().includes(searchQuery));
  items = items.sort((a, b) => b.created_at - a.created_at);

  listEl.innerHTML = "";
  if (!items.length) {
    listEl.innerHTML = `<div class="empty">No postings yet.</div>`;
    return;
  }
  items.forEach((p, i) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "item" + (p.id === selectedId ? " active" : "");
    row.style.animationDelay = `${Math.min(i, 8) * 0.03}s`;
    const badgeClass = p.status === "open" ? "completed" : p.status === "closed" ? "disconnected" : "created";
    row.innerHTML = `
      <div class="av"></div>
      <div class="info">
        <div class="role"></div>
        <div class="meta"><span></span></div>
      </div>
      <span class="badge ${badgeClass}"></span>`;
    row.querySelector(".av").style = avStyle(p.role);
    row.querySelector(".av").textContent = initials(p.role);
    row.querySelector(".role").textContent = p.role;
    row.querySelector(".meta span").textContent = `Requested by ${p.created_by} · ${fmtTime(p.created_at)}`;
    row.querySelector(".badge").textContent = p.status;
    row.onclick = () => selectPosting(p.id);
    listEl.appendChild(row);
  });
}

function selectPosting(id) {
  selectedId = id;
  const p = postings.find(x => x.id === id);
  if (!p) return;
  shell.classList.add("viewing");
  renderPostings();
  viewAv.hidden = false;
  viewAv.textContent = initials(p.role);
  viewAv.style = avStyle(p.role);
  viewTitle.textContent = p.role;
  viewMeta.textContent = `Requested by ${p.created_by} · ${fmtTime(p.created_at)}`;
  viewStatus.hidden = false;
  const badgeClass = p.status === "open" ? "completed" : p.status === "closed" ? "disconnected" : "created";
  viewStatus.className = `badge ${badgeClass}`;
  viewStatus.textContent = p.status;

  const appCount = applications.filter(a => a.job_id === p.id).length;
  const actions = p.status === "requested"
    ? `<div class="detail-actions"><button class="btn-primary" id="act-publish" style="flex:1;">Publish this posting</button></div>`
    : p.status === "open"
      ? `<div class="detail-actions"><button class="btn-secondary" id="act-close" style="flex:1;">Close posting</button></div>`
      : "";

  detailEl.innerHTML = `
    <div class="review-list">
      <div class="review-row"><span class="k">Applications</span><span class="v">${appCount}</span></div>
    </div>
    ${p.notes ? `<div class="sub" style="margin-bottom:8px;">Request note from ${p.created_by}</div><div class="jd-viewer scrollable">${p.notes}</div>` : ""}
    ${p.jd_text ? `<div class="sub" style="margin-bottom:8px;">Job description</div><div class="jd-viewer fill">${p.jd_text}</div>` : ""}
    ${actions}`;

  const publishBtn = document.getElementById("act-publish");
  const closeBtn = document.getElementById("act-close");
  if (publishBtn) publishBtn.onclick = () => openPublishModal(p);
  if (closeBtn) closeBtn.onclick = () => closePosting(p.id);
}

async function closePosting(id) {
  if (!confirm("Close this posting? It will no longer accept new applications.")) return;
  const resp = await fetch(`/api/postings/${id}/close`, { method: "POST" });
  if (!resp.ok) { showToast("Could not close this posting."); return; }
  showToast("Posting closed.", "success");
  await loadAll();
  selectPosting(id);
}

// ---------- create posting modal ----------
const createScrim = document.getElementById("create-posting-scrim");
const createForm = document.getElementById("create-posting-form");
const createErr = document.getElementById("create-posting-err");
const createSubmit = document.getElementById("create-posting-submit");
newPostingBtn.onclick = () => { createForm.reset(); createErr.hidden = true; createScrim.hidden = false; };
document.getElementById("create-posting-cancel").onclick = () => { createScrim.hidden = true; };
createScrim.addEventListener("click", (e) => { if (e.target === createScrim) createScrim.hidden = true; });
document.querySelector("#cp-jd-drop input").addEventListener("change", function () {
  const span = this.closest(".dropzone").querySelector("span");
  span.textContent = this.files[0] ? this.files[0].name : span.dataset.empty;
});
createForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  createErr.hidden = true;
  const fd = new FormData(createForm);
  if (!fd.get("jd_text").trim() && !fd.get("jd_file").name) {
    createErr.textContent = "Paste a job description or attach a file.";
    createErr.hidden = false;
    return;
  }
  createSubmit.disabled = true; createSubmit.textContent = "Publishing…";
  try {
    const resp = await fetch("/api/postings", { method: "POST", body: fd });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      createErr.textContent = body.detail || "Could not create this posting.";
      createErr.hidden = false;
      return;
    }
    createScrim.hidden = true;
    showToast("Posting published.", "success");
    await loadAll();
  } finally {
    createSubmit.disabled = false; createSubmit.textContent = "Publish posting";
  }
});

// ---------- publish (requested -> open) modal ----------
const publishScrim = document.getElementById("publish-scrim");
const publishForm = document.getElementById("publish-form");
const publishErr = document.getElementById("publish-err");
const publishSubmit = document.getElementById("publish-submit");
let publishingId = null;
function openPublishModal(p) {
  publishingId = p.id;
  publishForm.reset();
  document.getElementById("publish-sub").textContent =
    `Requested by ${p.created_by}${p.notes ? `: "${p.notes}"` : ""} — fill in the JD to open this role.`;
  publishErr.hidden = true;
  publishScrim.hidden = false;
}
document.getElementById("publish-cancel").onclick = () => { publishScrim.hidden = true; };
publishScrim.addEventListener("click", (e) => { if (e.target === publishScrim) publishScrim.hidden = true; });
document.querySelector("#pub-jd-drop input").addEventListener("change", function () {
  const span = this.closest(".dropzone").querySelector("span");
  span.textContent = this.files[0] ? this.files[0].name : span.dataset.empty;
});
publishForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  publishErr.hidden = true;
  const fd = new FormData(publishForm);
  if (!fd.get("jd_text").trim() && !fd.get("jd_file").name) {
    publishErr.textContent = "Paste a job description or attach a file.";
    publishErr.hidden = false;
    return;
  }
  publishSubmit.disabled = true; publishSubmit.textContent = "Publishing…";
  try {
    const resp = await fetch(`/api/postings/${publishingId}/publish`, { method: "POST", body: fd });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      publishErr.textContent = body.detail || "Could not publish this posting.";
      publishErr.hidden = false;
      return;
    }
    publishScrim.hidden = true;
    showToast("Posting published.", "success");
    const id = publishingId;
    await loadAll();
    selectPosting(id);
  } finally {
    publishSubmit.disabled = false; publishSubmit.textContent = "Publish";
  }
});

loadMe();
loadAll();
