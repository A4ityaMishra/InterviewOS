// Internal test/setup room ("/"): builds a session from a JD form, then hands
// off to the shared call runtime in call.js. Real candidates use join.js via
// the /interview/<id> link generated from the ops dashboard instead.

const startBtn = document.getElementById("start");
const setupForm = document.getElementById("setup");
const setupCard = document.getElementById("setup-card");
const heroEl = document.getElementById("hero");
// callEl is declared once in call.js (loaded first) — reused here
const doneCard = document.getElementById("done");
const doneTitle = document.getElementById("done-title");
const doneSub = document.getElementById("done-sub");
const navLinks = document.querySelectorAll(".nav-guard, .brand");

function confirmLeave(e) {
  if (!interviewLive()) return; // plain navigation when no call is active
  if (!confirm("Leave the interview? The session will end and can't be resumed.")) {
    e.preventDefault();
    return;
  }
  if (typeof ws !== "undefined" && ws) ws.close();
}
navLinks.forEach(a => a.addEventListener("click", confirmLeave));

// ---------- file input labels ----------
for (const zoneId of ["jd-drop", "resume-drop", "docs-drop"]) {
  const zone = document.getElementById(zoneId);
  const input = zone.querySelector("input");
  const label = zone.querySelector("span");
  input.addEventListener("change", () => {
    label.textContent = input.files.length
      ? [...input.files].map(f => f.name).join(", ")
      : label.dataset.empty;
    label.classList.toggle("files", input.files.length > 0);
  });
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", e => {
    e.preventDefault();
    zone.classList.remove("drag");
    input.files = e.dataTransfer.files;
    input.dispatchEvent(new Event("change"));
  });
}

async function createSession() {
  if (!setupForm.jd_text.value.trim() && !setupForm.jd_file.files[0]) {
    throw new Error("A job description is required — paste text or attach a file");
  }
  if (!setupForm.resume_file.files[0]) {
    throw new Error("A candidate resume is required");
  }
  const fd = new FormData();
  fd.append("role", setupForm.role.value);
  fd.append("jd_text", setupForm.jd_text.value);
  fd.append("duration_min", setupForm.duration_min.value || "20");
  fd.append("provider", setupForm.provider.value || "pipeline");
  fd.append("topics", setupForm.topics.value || "");
  if (setupForm.jd_file.files[0]) fd.append("jd_file", setupForm.jd_file.files[0]);
  fd.append("resume_file", setupForm.resume_file.files[0]);
  for (const f of setupForm.docs.files) fd.append("docs", f);
  const resp = await fetch("/api/session", { method: "POST", body: fd });
  if (resp.status === 401) { window.location.href = "/login"; throw new Error("not authenticated"); }
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail || `setup failed: ${resp.status}`);
  }
  return (await resp.json()).session_id;
}

// ---------- user chip (topnav) ----------
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
(async function loadMe() {
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
})();
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

function showDone({ title, sub }) {
  if (typeof micStream !== "undefined" && micStream) micStream.getTracks().forEach(t => t.stop());
  callEl.hidden = true;
  doneCard.hidden = false;
  doneTitle.textContent = title;
  doneSub.textContent = sub;
  if (window.fxWordReveal) window.fxWordReveal(doneTitle);
}

setupForm.onsubmit = async (e) => {
  e.preventDefault();
  startBtn.disabled = true;
  startBtn.textContent = "Preparing interview…";
  try {
    const sessionId = await createSession();
    setupCard.hidden = true;
    if (heroEl) heroEl.hidden = true;
    callEl.hidden = false;
    await startCall(sessionId, { onEnd: showDone });
  } catch (err) {
    startBtn.disabled = false;
    startBtn.textContent = "Start interview";
    alert(`Could not start: ${err.message}`);
  }
};
