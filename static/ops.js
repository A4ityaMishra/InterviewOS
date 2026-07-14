const sessionsEl = document.getElementById("sessions");
const transcriptEl = document.getElementById("transcript");
const titleEl = document.getElementById("view-title");
const metaEl = document.getElementById("view-meta");
const statusEl = document.getElementById("view-status");
const shell = document.getElementById("shell");
const backBtn = document.getElementById("back");
const filterEl = document.getElementById("filter");
const viewAv = document.getElementById("view-av");
const stTotal = document.getElementById("st-total");
const stLive = document.getElementById("st-live");
const stDone = document.getElementById("st-done");

let selectedId = null;
let allSessions = [];

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
  allSessions = await resp.json();
  stTotal.textContent = allSessions.length;
  stLive.textContent = allSessions.filter(s => s.status === "live").length;
  stDone.textContent = allSessions.filter(s => s.status === "completed").length;
  renderSessions();
}

function renderSessions() {
  const q = filterEl.value.trim().toLowerCase();
  const sessions = q ? allSessions.filter(s => s.role.toLowerCase().includes(q)) : allSessions;
  sessionsEl.innerHTML = "";
  if (!sessions.length) {
    sessionsEl.innerHTML = `<div class="empty">${
      q ? "No interviews match that filter." : "No interviews yet.<br>Sessions appear here as soon as one is created."
    }</div>`;
    return;
  }
  for (const s of sessions) {
    const btn = document.createElement("button");
    btn.className = `item${s.id === selectedId ? " active" : ""}`;
    btn.innerHTML = `
      <div class="av" style="${avStyle(s.role)}"></div>
      <div class="info">
        <div class="role"></div>
        <div class="meta">
          <span>${fmtTime(s.created_at)}</span>
          <span>·</span>
          <span>${s.message_count} turns</span>
        </div>
      </div>
      <span class="badge ${s.status}">${s.status}</span>`;
    btn.querySelector(".av").textContent = initials(s.role);
    btn.querySelector(".role").textContent = s.role;
    btn.onclick = () => select(s.id);
    sessionsEl.appendChild(btn);
  }
}

async function select(id) {
  selectedId = id;
  shell.classList.add("viewing");
  await loadTranscript();
  renderSessions();
}

async function loadTranscript() {
  if (!selectedId) return;
  const resp = await fetch(`/api/ops/sessions/${selectedId}`);
  const d = await resp.json();
  if (d.error) return;

  titleEl.textContent = d.role;
  metaEl.textContent = `${fmtTime(d.created_at)} · planned ${d.duration_min} min · ${d.messages.length} turns`;
  viewAv.hidden = false;
  viewAv.style = avStyle(d.role);
  viewAv.textContent = initials(d.role);
  statusEl.hidden = false;
  statusEl.className = `badge ${d.status}`;
  statusEl.textContent = d.status;

  const atBottom =
    transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight < 60;

  transcriptEl.innerHTML = "";
  if (!d.messages.length) {
    transcriptEl.innerHTML = `<div class="placeholder">No conversation recorded yet.</div>`;
  }
  for (const m of d.messages) {
    const turn = document.createElement("div");
    turn.className = `turn ${m.speaker}`;
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
    transcriptEl.appendChild(turn);
  }
  if (atBottom) transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

backBtn.onclick = () => {
  shell.classList.remove("viewing");
  selectedId = null;
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

for (const zoneId of ["jd-drop", "docs-drop"]) {
  const zone = document.getElementById(zoneId);
  const input = zone.querySelector("input");
  const label = zone.querySelector("span");
  input.addEventListener("change", () => {
    label.textContent = input.files.length
      ? [...input.files].map(f => f.name).join(", ")
      : label.dataset.empty;
  });
}

function openModal() {
  scrim.hidden = false;
  newForm.hidden = false;
  linkResult.hidden = true;
  newForm.reset();
  document.querySelectorAll("#modal-create .dropzone span").forEach(s => s.textContent = s.dataset.empty);
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
    if (!resp.ok) throw new Error(`request failed (${resp.status})`);
    const { session_id } = await resp.json();
    const link = `${location.origin}/interview/${session_id}`;
    linkInput.value = link;
    newForm.hidden = true;
    linkResult.hidden = false;
    copyBtn.textContent = "Copy";
    copyBtn.classList.remove("copied");
  } catch (err) {
    alert(`Could not create interview: ${err.message}`);
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

loadSessions();
setInterval(() => { loadSessions(); loadTranscript(); }, 4000);
