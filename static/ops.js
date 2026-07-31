const sessionsEl = document.getElementById("sessions");
const transcriptEl = document.getElementById("transcript");
const titleEl = document.getElementById("view-title");
const titleBtn = document.getElementById("view-title-btn");
const metaEl = document.getElementById("view-meta");
const statusEl = document.getElementById("view-status");
const shell = document.getElementById("shell");
const backBtn = document.getElementById("back");
const filterEl = document.getElementById("filter");
const viewAv = document.getElementById("view-av");
const stTotal = document.getElementById("st-total");
const stCreated = document.getElementById("st-created");
const stLive = document.getElementById("st-live");
const stDone = document.getElementById("st-done");
const stDisconnected = document.getElementById("st-disconnected");

let selectedId = null;
let allSessions = [];
let currentDetail = null;
let hasRenderedOnce = false;
const prevMessageCounts = new Map();
let renderedForId = null;
let renderedMessageCount = 0;

let statusFilter = "all"; // all | created | live | completed | disconnected
let timeFilter = "all"; // all | 24h | 7d | 30d
let sortOrder = "newest"; // newest | oldest
const TIME_FILTER_MS = { "24h": 864e5, "7d": 7 * 864e5, "30d": 30 * 864e5 };

const timeFilterEl = document.getElementById("time-filter");
const sortOrderEl = document.getElementById("sort-order");
const statTiles = document.querySelectorAll(".status-filter [data-filter]");
statTiles.forEach((el) => {
  el.addEventListener("click", () => {
    statusFilter = el.dataset.filter;
    statTiles.forEach((t) => {
      const active = t === el;
      t.classList.toggle("active", active);
      t.setAttribute("aria-checked", active ? "true" : "false");
    });
    renderSessions();
  });
});
timeFilterEl.addEventListener("change", () => { timeFilter = timeFilterEl.value; renderSessions(); });
sortOrderEl.addEventListener("change", () => { sortOrder = sortOrderEl.value; renderSessions(); });

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

function animateCount(el, to, duration = 600) {
  const from = Number(el.textContent) || 0;
  if (from === to) { el.textContent = to; return; }
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (to - from) * eased);
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

const fmtTime = ts => new Date(ts * 1000).toLocaleString([], {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});
const fmtClock = ts => new Date(ts * 1000).toLocaleTimeString([], {
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const initials = role =>
  role.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("") || "?";

// stable pleasant gradient per role
const AV_GRADIENTS = [
  ["#6366f1", "#4338ca"], ["#10b981", "#047857"], ["#f97316", "#c2410c"],
  ["#8b5cf6", "#6d28d9"], ["#ec4899", "#be185d"], ["#0ea5e9", "#0369a1"],
];
function avStyle(role) {
  let h = 0;
  for (const ch of role) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [a, b] = AV_GRADIENTS[h % AV_GRADIENTS.length];
  return `background: linear-gradient(135deg, ${a}, ${b})`;
}

async function loadSessions() {
  const resp = await fetch("/api/ops/sessions");
  if (resp.status === 401) { window.location.href = "/login"; return; }
  allSessions = await resp.json();
  animateCount(stTotal, allSessions.length);
  animateCount(stCreated, allSessions.filter(s => s.status === "created").length);
  animateCount(stLive, allSessions.filter(s => s.status === "live").length);
  animateCount(stDone, allSessions.filter(s => s.status === "completed").length);
  animateCount(stDisconnected, allSessions.filter(s => s.status === "disconnected").length);
  renderSessions();
}

function renderSessions() {
  const q = filterEl.value.trim().toLowerCase();
  const anyFilterActive = q || statusFilter !== "all" || timeFilter !== "all";
  const cutoffMs = TIME_FILTER_MS[timeFilter];

  let sessions = allSessions.filter((s) => {
    if (q && !s.role.toLowerCase().includes(q) && !s.id.toLowerCase().includes(q) && !s.job_id.toLowerCase().includes(q)) return false;
    if (statusFilter !== "all" && s.status !== statusFilter) return false;
    if (cutoffMs && Date.now() - s.created_at * 1000 > cutoffMs) return false;
    return true;
  });
  sessions = sessions.slice().sort((a, b) =>
    sortOrder === "newest" ? b.created_at - a.created_at : a.created_at - b.created_at
  );

  sessionsEl.innerHTML = "";
  if (!sessions.length) {
    sessionsEl.innerHTML = `<div class="empty">${
      anyFilterActive ? "No interviews match these filters." : "No interviews yet.<br>Sessions appear here as soon as one is created."
    }</div>`;
    return;
  }
  sessions.forEach((s, i) => {
    const prevCount = prevMessageCounts.get(s.id);
    const justGotNewMessage = hasRenderedOnce && s.status === "live" && prevCount !== undefined && s.message_count > prevCount;
    prevMessageCounts.set(s.id, s.message_count);

    const primaryLabel = s.applicant_name || s.role;

    const btn = document.createElement("button");
    btn.className = `item${s.id === selectedId ? " active" : ""}${hasRenderedOnce ? "" : " entering"}${justGotNewMessage ? " flash" : ""}`;
    if (!hasRenderedOnce) btn.style.animationDelay = `${Math.min(i, 10) * 0.03}s`;
    btn.innerHTML = `
      <div class="av" style="${avStyle(primaryLabel)}"></div>
      <div class="info">
        <div class="role"></div>
        ${s.applicant_name ? `<div class="applicant-role"></div>` : ""}
        <div class="meta">
          <span>${fmtTime(s.created_at)}</span>
          <span>·</span>
          <span>${s.message_count} turns</span>
          ${s.provider === "realtime" ? '<span>·</span><span class="engine-tag">realtime</span>' : ""}
          ${s.job_id !== s.id ? `<span>·</span><span class="id-tag" title="Posting ID: ${s.job_id}">posting #${s.job_id.slice(0, 8)}</span>` : ""}
          <span>·</span>
          <span class="id-tag" title="${s.id}">#${s.id.slice(0, 8)}</span>
        </div>
      </div>
      <span class="badge ${s.status}">${s.status}</span>`;
    btn.querySelector(".av").textContent = initials(primaryLabel);
    btn.querySelector(".role").textContent = primaryLabel;
    if (s.applicant_name) btn.querySelector(".applicant-role").textContent = s.role;
    btn.onclick = () => select(s.id);
    sessionsEl.appendChild(btn);
  });
  hasRenderedOnce = true;
}

async function select(id) {
  selectedId = id;
  if (currentDetail && currentDetail.id !== id) {
    currentDetail = null;
    titleBtn.disabled = true;
  }
  shell.classList.add("viewing");
  await loadTranscript();
  renderSessions();
}

async function loadTranscript() {
  if (!selectedId) return;
  const resp = await fetch(`/api/ops/sessions/${selectedId}`);
  if (resp.status === 401) { window.location.href = "/login"; return; }
  const d = await resp.json();
  if (d.error) return;
  currentDetail = d;
  titleBtn.disabled = false;

  if (titleEl.textContent !== d.role) {
    titleEl.textContent = d.role;
    delete titleEl.dataset.fxDone;
    if (window.fxWordReveal) window.fxWordReveal(titleEl);
  }
  const engineNote = d.provider === "realtime" ? " · realtime mini" : "";
  metaEl.textContent = `${fmtTime(d.created_at)} · planned ${d.duration_min} min · ${d.messages.length} turns${engineNote}`;
  viewAv.hidden = false;
  viewAv.style = avStyle(d.role);
  viewAv.textContent = initials(d.role);
  statusEl.hidden = false;
  statusEl.className = `badge ${d.status}`;
  statusEl.textContent = d.status;

  const atBottom =
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60;

  function buildTurn(m, isNew) {
    const turn = document.createElement("div");
    turn.className = `turn ${m.speaker}${isNew ? " new-turn" : ""}`;
    const who = document.createElement("div");
    who.className = "who";
    who.innerHTML = `<span></span><time>${fmtClock(m.ts)}</time>`;
    who.querySelector("span").textContent = m.speaker === "agent" ? "Interviewer" : "Candidate";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = m.text;
    turn.append(who, bubble);
    if (m.interrupted) {
      const cut = document.createElement("div");
      cut.className = "cut";
      cut.textContent = "interrupted by candidate";
      turn.appendChild(cut);
    }
    return turn;
  }

  // switching to a different session (or first load) — full rebuild, no
  // per-message "new" animation. Re-polling the SAME session only appends
  // whatever arrived since the last poll, so already-read messages never
  // replay their entrance.
  const isFreshSession = renderedForId !== selectedId;
  if (isFreshSession) {
    transcriptEl.innerHTML = "";
    if (!d.messages.length) {
      transcriptEl.innerHTML = `<div class="placeholder">No conversation recorded yet.</div>`;
    }
    for (const m of d.messages) transcriptEl.appendChild(buildTurn(m, false));
    renderedForId = selectedId;
    renderedMessageCount = d.messages.length;
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  } else if (d.messages.length > renderedMessageCount) {
    const placeholder = transcriptEl.querySelector(".placeholder");
    if (placeholder) placeholder.remove();
    for (const m of d.messages.slice(renderedMessageCount)) {
      transcriptEl.appendChild(buildTurn(m, true));
    }
    renderedMessageCount = d.messages.length;
    if (atBottom) transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: "smooth" });
  }
}

backBtn.onclick = () => {
  shell.classList.remove("viewing");
  selectedId = null;
  currentDetail = null;
  titleBtn.disabled = true;
  statusEl.hidden = true;
  viewAv.hidden = true;
  titleEl.textContent = "Select an interview";
  metaEl.textContent = "";
  renderSessions();
};

filterEl.oninput = renderSessions;

// ---------- new interview modal ----------
const newBtn = document.getElementById("new-btn");
const scrim = document.getElementById("modal-scrim");
const newForm = document.getElementById("new-form");
const modalSubmit = document.getElementById("modal-submit");
const modalCancel = document.getElementById("modal-cancel");
const modalDone = document.getElementById("modal-done");
const linkResult = document.getElementById("link-result");
const linkInput = document.getElementById("link-input");
const copyBtn = document.getElementById("copy-btn");

for (const zoneId of ["jd-drop", "resume-drop", "docs-drop", "schedule-app-docs-drop"]) {
  const zone = document.getElementById(zoneId);
  const input = zone.querySelector("input");
  const label = zone.querySelector("span");
  input.addEventListener("change", () => {
    label.textContent = input.files.length
      ? [...input.files].map(f => f.name).join(", ")
      : label.dataset.empty;
  });
}

// ---------- modal step wizard: role/duration -> JD -> docs -> review ----------
const modalSteps = [0, 1, 2, 3].map(i => document.getElementById(`mstep-${i}`));
const modalDots = [...document.querySelectorAll("#modal-dots .d")];
let modalStep = 0;

function goToModalStep(i, direction = "forward") {
  modalStep = i;
  modalSteps.forEach((el, idx) => { el.hidden = idx !== i; });
  const el = modalSteps[i];
  el.classList.toggle("back", direction === "back");
  void el.offsetWidth;
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";
  modalDots.forEach((d, idx) => {
    d.classList.toggle("active", idx === i);
    d.classList.toggle("done", idx < i);
  });
  if (i === 3) fillReview();
}

function fillReview() {
  const fd = new FormData(newForm);
  const role = (fd.get("role") || "").trim() || "Untitled role";
  const duration = fd.get("duration_min") || "20";
  const jdText = (fd.get("jd_text") || "").trim();
  const jdFile = newForm.jd_file.files[0];
  const resumeFile = newForm.resume_file.files[0];
  const docs = newForm.docs.files;

  const engine = fd.get("provider") === "realtime" ? "Realtime mini" : "Our pipeline";

  document.getElementById("rv-role").textContent = role;
  document.getElementById("rv-duration").textContent = `${duration} min`;
  document.getElementById("rv-engine").textContent = engine;

  const jdEl = document.getElementById("rv-jd");
  if (jdFile) { jdEl.textContent = jdFile.name; jdEl.classList.remove("muted"); }
  else if (jdText) { jdEl.textContent = jdText.slice(0, 40) + (jdText.length > 40 ? "…" : ""); jdEl.classList.remove("muted"); }
  else { jdEl.textContent = "None provided"; jdEl.classList.add("muted"); }

  const resumeEl = document.getElementById("rv-resume");
  if (resumeFile) { resumeEl.textContent = resumeFile.name; resumeEl.classList.remove("muted"); }
  else { resumeEl.textContent = "None provided"; resumeEl.classList.add("muted"); }

  const topics = (fd.get("topics") || "").trim();
  const topicsEl = document.getElementById("rv-topics");
  if (topics) { topicsEl.textContent = topics; topicsEl.classList.remove("muted"); }
  else { topicsEl.textContent = "Open (derived from JD)"; topicsEl.classList.add("muted"); }

  const docsEl = document.getElementById("rv-docs");
  if (docs.length) { docsEl.textContent = `${docs.length} file${docs.length > 1 ? "s" : ""}`; docsEl.classList.remove("muted"); }
  else { docsEl.textContent = "None"; docsEl.classList.add("muted"); }
}

document.getElementById("m-to-1").onclick = () => {
  if (!newForm.role.value.trim()) {
    newForm.role.reportValidity();
    return;
  }
  goToModalStep(1);
};
document.getElementById("m-back-0").onclick = () => goToModalStep(0, "back");
document.getElementById("m-to-2").onclick = () => {
  const hasJd = newForm.jd_text.value.trim() || newForm.jd_file.files.length;
  if (!hasJd) {
    showToast("A job description is required — paste text or attach a file");
    return;
  }
  goToModalStep(2);
};
document.getElementById("m-back-1").onclick = () => goToModalStep(1, "back");
document.getElementById("m-to-3").onclick = () => {
  if (!newForm.resume_file.files.length) {
    showToast("A candidate resume is required");
    return;
  }
  goToModalStep(3);
};
document.getElementById("m-back-2").onclick = () => goToModalStep(2, "back");

function openModal() {
  scrim.hidden = false;
  newForm.hidden = false;
  linkResult.hidden = true;
  newForm.reset();
  document.querySelectorAll("#modal-create .dropzone span").forEach(s => s.textContent = s.dataset.empty);
  goToModalStep(0);
}
function closeModal() { scrim.hidden = true; }

newBtn.onclick = openModal;
modalCancel.onclick = closeModal;
modalDone.onclick = () => { closeModal(); loadSessions(); };
scrim.onclick = (e) => { if (e.target === scrim) closeModal(); };

newForm.onsubmit = async (e) => {
  e.preventDefault();
  modalSubmit.disabled = true;
  modalSubmit.textContent = "Creating…";
  try {
    const fd = new FormData(newForm);
    const resp = await fetch("/api/session", { method: "POST", body: fd });
    if (resp.status === 401) { window.location.href = "/login"; return; }
    if (!resp.ok) throw new Error(`request failed (${resp.status})`);
    const { session_id } = await resp.json();
    const link = `${location.origin}/interview/${session_id}`;
    linkInput.value = link;
    newForm.hidden = true;
    linkResult.hidden = false;
    copyBtn.textContent = "Copy";
    copyBtn.classList.remove("copied");
  } catch (err) {
    showToast(`Could not create interview: ${err.message}`);
  } finally {
    modalSubmit.disabled = false;
    modalSubmit.textContent = "Create link";
  }
};

copyBtn.onclick = async () => {
  linkInput.select();
  try {
    await navigator.clipboard.writeText(linkInput.value);
  } catch {
    document.execCommand("copy");
  }
  copyBtn.textContent = "Copied";
  copyBtn.classList.add("copied");
};

// ---------- request a posting ----------
const reqScrim = document.getElementById("request-posting-scrim");
const reqForm = document.getElementById("request-posting-form");
const reqErr = document.getElementById("request-posting-err");
const reqSubmit = document.getElementById("request-posting-submit");
const reqResult = document.getElementById("request-posting-result");

document.getElementById("request-posting-btn").onclick = () => {
  reqForm.reset();
  reqForm.hidden = false;
  reqResult.hidden = true;
  reqErr.hidden = true;
  reqScrim.hidden = false;
};
document.getElementById("request-posting-cancel").onclick = () => { reqScrim.hidden = true; };
reqScrim.addEventListener("click", (e) => { if (e.target === reqScrim) reqScrim.hidden = true; });
document.getElementById("request-posting-done").onclick = () => { reqScrim.hidden = true; };

reqForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  reqErr.hidden = true;
  reqSubmit.disabled = true;
  reqSubmit.textContent = "Sending…";
  try {
    const fd = new FormData(reqForm);
    const resp = await fetch("/api/postings/request", { method: "POST", body: fd });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      reqErr.textContent = body.detail || "Could not send that request.";
      reqErr.hidden = false;
      return;
    }
    reqForm.hidden = true;
    reqResult.hidden = false;
  } finally {
    reqSubmit.disabled = false;
    reqSubmit.textContent = "Send request";
  }
});

// ---------- schedule from an approved application ----------
const scheduleScrim = document.getElementById("schedule-app-scrim");
const schedulePick = document.getElementById("schedule-app-pick");
const scheduleList = document.getElementById("schedule-app-list");
const scheduleForm = document.getElementById("schedule-app-form");
const scheduleSub = document.getElementById("schedule-app-sub");
const scheduleErr = document.getElementById("schedule-app-err");
const scheduleSubmit = document.getElementById("schedule-app-submit");
const scheduleResult = document.getElementById("schedule-app-result");
const scheduleLinkInput = document.getElementById("schedule-app-link-input");
let schedulingApplicationId = null;

async function openScheduleModal() {
  schedulePick.hidden = false;
  scheduleForm.hidden = true;
  scheduleResult.hidden = true;
  scheduleList.innerHTML = `<div class="empty" style="padding:20px 0;">Loading…</div>`;
  scheduleScrim.hidden = false;

  const [appsResp, postingsResp] = await Promise.all([
    fetch("/api/applications"),
    fetch("/api/postings"),
  ]);
  const apps = await appsResp.json();
  const postings = await postingsResp.json();
  const postingsById = Object.fromEntries(postings.map(p => [p.id, p]));

  // general applications (from /apply/general) have no posting/JD behind
  // them to prefill from, so they're not eligible for this one-click flow —
  // schedule those via the regular "New interview" flow instead
  const ready = apps.filter(a => a.status === "approved" && !a.session_id && a.job_id !== "general");
  if (!ready.length) {
    scheduleList.innerHTML = `<div class="empty" style="padding:20px 0;">No approved applications waiting to be scheduled.</div>`;
    return;
  }
  scheduleList.innerHTML = "";
  ready.forEach((a) => {
    const posting = postingsById[a.job_id];
    const row = document.createElement("button");
    row.type = "button";
    row.className = "pickable-row";
    row.innerHTML = `<div><div class="name"></div><div class="role"></div></div>`;
    row.querySelector(".name").textContent = a.applicant_name;
    row.querySelector(".role").textContent = posting ? posting.role : "Unknown role";
    row.onclick = () => pickApplication(a, posting);
    scheduleList.appendChild(row);
  });
}

function pickApplication(app, posting) {
  schedulingApplicationId = app.id;
  schedulePick.hidden = true;
  scheduleForm.hidden = false;
  scheduleErr.hidden = true;
  scheduleForm.reset();
  scheduleForm.duration_min.value = (posting && posting.duration_min) || 20;
  scheduleForm.topics.value = (posting && posting.topics) || "";
  scheduleSub.textContent = `${app.applicant_name} — ${posting ? posting.role : "Unknown role"}`;
  // form.reset() clears the file input's value, but not the dropzone label
  // text we set manually on "change" — reset it back to its default too
  const docsLabel = document.querySelector("#schedule-app-docs-drop span");
  docsLabel.textContent = docsLabel.dataset.empty;
}

document.getElementById("schedule-app-btn").onclick = openScheduleModal;
document.getElementById("schedule-app-back").onclick = () => {
  schedulePick.hidden = false;
  scheduleForm.hidden = true;
};
scheduleScrim.addEventListener("click", (e) => { if (e.target === scheduleScrim) scheduleScrim.hidden = true; });
document.getElementById("schedule-app-done").onclick = () => { scheduleScrim.hidden = true; loadSessions(); loadScheduleAppBadge(); };

scheduleForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  scheduleErr.hidden = true;
  scheduleSubmit.disabled = true;
  scheduleSubmit.textContent = "Creating…";
  try {
    const fd = new FormData(scheduleForm);
    const resp = await fetch(`/api/applications/${schedulingApplicationId}/schedule`, { method: "POST", body: fd });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      scheduleErr.textContent = body.detail || "Could not schedule this interview.";
      scheduleErr.hidden = false;
      return;
    }
    const { session_id } = await resp.json();
    scheduleLinkInput.value = `${location.origin}/interview/${session_id}`;
    scheduleForm.hidden = true;
    scheduleResult.hidden = false;
  } finally {
    scheduleSubmit.disabled = false;
    scheduleSubmit.textContent = "Create link";
  }
});

document.getElementById("schedule-app-copy-btn").onclick = async () => {
  scheduleLinkInput.select();
  try {
    await navigator.clipboard.writeText(scheduleLinkInput.value);
  } catch {
    document.execCommand("copy");
  }
  const btn = document.getElementById("schedule-app-copy-btn");
  btn.textContent = "Copied";
  btn.classList.add("copied");
};

// ---------- interview details panel ----------
const detailScrim = document.getElementById("detail-scrim");
const fmtDuration = (seconds) => {
  const mins = Math.round(seconds / 60);
  if (mins < 1) return `${Math.max(1, Math.round(seconds))}s`;
  return `${mins} min`;
};

titleBtn.onclick = () => {
  const d = currentDetail;
  if (!d) return;
  document.getElementById("dt-role").textContent = d.role;
  document.getElementById("dt-jobid").textContent = d.job_id || d.id;
  document.getElementById("dt-sessionid").textContent = d.id;
  document.getElementById("dt-status").textContent = d.status;
  document.getElementById("dt-engine").textContent = d.provider === "realtime" ? "Realtime mini" : "Our pipeline";
  document.getElementById("dt-created").textContent = fmtTime(d.created_at);
  document.getElementById("dt-planned").textContent = `${d.duration_min} min`;

  const endTs = d.ended_at || (d.messages.length ? d.messages[d.messages.length - 1].ts : null);
  const actualEl = document.getElementById("dt-actual");
  if (endTs) { actualEl.textContent = fmtDuration(endTs - d.created_at); actualEl.classList.remove("muted"); }
  else { actualEl.textContent = d.status === "live" ? "In progress" : "—"; actualEl.classList.add("muted"); }

  const applicantSection = document.getElementById("dt-applicant-section");
  if (d.applicant_name) {
    document.getElementById("dt-applicant-name").textContent = d.applicant_name;
    document.getElementById("dt-applicant-email").textContent = d.applicant_email;
    document.getElementById("dt-resume").textContent = d.resume_text && d.resume_text.trim() ? d.resume_text : "No resume on file.";
    applicantSection.hidden = false;
  } else {
    applicantSection.hidden = true;
  }

  document.getElementById("dt-turns").textContent = d.messages.length;
  document.getElementById("dt-topics").textContent = d.topics && d.topics.trim() ? d.topics : "Account default";

  const costHeading = document.getElementById("dt-cost-heading");
  const costList = document.getElementById("dt-cost-list");
  if (d.cost) {
    costHeading.hidden = false;
    costList.hidden = false;
    const fmtUsd = v => `$${v.toFixed(v < 0.01 ? 4 : 3)}`;
    document.getElementById("dt-cost-llm").textContent =
      `${fmtUsd(d.cost.llm_cost)} (${d.cost.llm_prompt_tokens + d.cost.llm_completion_tokens} tok)`;
    document.getElementById("dt-cost-stt").textContent =
      `${fmtUsd(d.cost.stt_cost)} (${d.cost.stt_seconds}s)`;
    document.getElementById("dt-cost-tts").textContent =
      `${fmtUsd(d.cost.tts_cost)} (${d.cost.tts_seconds}s)`;
    document.getElementById("dt-cost-total").textContent = fmtUsd(d.cost.total_cost);
  } else {
    costHeading.hidden = true;
    costList.hidden = true;
  }

  const jdEl = document.getElementById("dt-jd");
  jdEl.textContent = d.jd_text && d.jd_text.trim() ? d.jd_text : "No job description was provided for this interview.";

  const linkSection = document.getElementById("dt-link-section");
  const linkInputEl = document.getElementById("dt-link-input");
  if (d.status === "created") {
    linkInputEl.value = `${location.origin}/interview/${d.id}`;
    linkSection.hidden = false;
  } else {
    linkSection.hidden = true;
  }

  detailScrim.hidden = false;
};

document.getElementById("dt-link-copy-btn").onclick = async (e) => {
  const btn = e.currentTarget;
  const input = document.getElementById("dt-link-input");
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    document.execCommand("copy");
  }
  btn.textContent = "Copied";
  btn.classList.add("copied");
  setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1500);
};

document.getElementById("detail-close").onclick = () => { detailScrim.hidden = true; };
detailScrim.addEventListener("click", (e) => { if (e.target === detailScrim) detailScrim.hidden = true; });

// ---------- user chip (topnav) ----------
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
  if (user.team === "hr" || user.is_admin) document.getElementById("nav-hr").hidden = false;
  return user;
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
  pwForm.reset();
  pwForm.hidden = false;
  pwErr.hidden = true;
  pwSuccess.hidden = true;
  pwScrim.hidden = false;
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
  pwSubmit.disabled = true;
  pwSubmit.textContent = "Updating…";
  try {
    const resp = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password: fd.get("current_password"), new_password: newPassword }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      pwErr.textContent = body.detail || "Could not update your password.";
      pwErr.hidden = false;
      return;
    }
    pwForm.hidden = true;
    pwSuccess.hidden = false;
  } finally {
    pwSubmit.disabled = false;
    pwSubmit.textContent = "Update password";
  }
});

// ---------- "schedule from application" badge ----------
// same eligibility rule as openScheduleModal's `ready` filter — approved,
// not yet scheduled, and tied to a real posting (general applications have
// no JD to prefill from, so they don't count here either)
const scheduleAppBadge = document.getElementById("schedule-app-badge");
async function loadScheduleAppBadge() {
  try {
    const resp = await fetch("/api/applications");
    if (!resp.ok) return;
    const apps = await resp.json();
    const count = apps.filter(a => a.status === "approved" && !a.session_id && a.job_id !== "general").length;
    if (count > 0) {
      scheduleAppBadge.textContent = count > 99 ? "99+" : String(count);
      scheduleAppBadge.hidden = false;
    } else {
      scheduleAppBadge.hidden = true;
    }
  } catch {
    /* leave the badge as-is on a transient fetch failure */
  }
}

loadMe();
loadSessions();
loadScheduleAppBadge();
setInterval(() => { loadSessions(); loadTranscript(); loadScheduleAppBadge(); }, 4000);
