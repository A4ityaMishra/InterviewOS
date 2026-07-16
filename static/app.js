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
for (const zoneId of ["jd-drop", "docs-drop"]) {
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
  const fd = new FormData();
  fd.append("role", setupForm.role.value);
  fd.append("jd_text", setupForm.jd_text.value);
  fd.append("duration_min", setupForm.duration_min.value || "20");
  fd.append("provider", setupForm.provider.value || "pipeline");
  if (setupForm.jd_file.files[0]) fd.append("jd_file", setupForm.jd_file.files[0]);
  for (const f of setupForm.docs.files) fd.append("docs", f);
  const resp = await fetch("/api/session", { method: "POST", body: fd });
  if (!resp.ok) throw new Error(`setup failed: ${resp.status}`);
  return (await resp.json()).session_id;
}

function showDone({ title, sub }) {
  if (typeof micStream !== "undefined" && micStream) micStream.getTracks().forEach(t => t.stop());
  callEl.hidden = true;
  doneCard.hidden = false;
  doneTitle.textContent = title;
  doneSub.textContent = sub;
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
