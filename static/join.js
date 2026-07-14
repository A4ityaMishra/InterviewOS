// Candidate-facing join flow: no JD form, no ops nav, no restart option after
// completion. The session already exists (created from the ops dashboard);
// this page only needs its id from the URL.

const lobby = document.getElementById("lobby");
const rolePill = document.getElementById("role-pill");
const durText = document.getElementById("dur-text");
const startBtn = document.getElementById("start");
const errEl = document.getElementById("err");
// callEl is declared once in call.js (loaded first) — reused here
const doneCard = document.getElementById("done");
const doneTitle = document.getElementById("done-title");
const doneSub = document.getElementById("done-sub");

const sessionId = location.pathname.split("/").filter(Boolean).pop();

async function loadInfo() {
  try {
    const resp = await fetch(`/api/interviews/${sessionId}/public`);
    const info = await resp.json();
    if (info.error) throw new Error("not found");
    rolePill.textContent = info.role;
    durText.textContent = info.duration_min;
    if (info.status === "completed") {
      startBtn.disabled = true;
      startBtn.textContent = "This interview has already been completed";
    } else if (info.status === "live") {
      startBtn.disabled = true;
      startBtn.textContent = "This interview is already in progress";
    }
  } catch {
    lobby.querySelector("h1").textContent = "This interview link isn't valid";
    lobby.querySelector("p").textContent =
      "It may have expired or the link was copied incorrectly. Please check with your recruiter.";
    startBtn.hidden = true;
    document.querySelector(".checks").hidden = true;
    rolePill.hidden = true;
  }
}

function showDone({ title, sub }) {
  if (typeof micStream !== "undefined" && micStream) micStream.getTracks().forEach(t => t.stop());
  callEl.hidden = true;
  doneCard.hidden = false;
  doneTitle.textContent = title;
  // candidates never get a "start again" option — just tell them what's next
  doneSub.textContent = title === "Interview complete"
    ? sub
    : "Your responses so far have been saved. If you'd like to continue, please reach out to your recruiter for a new link.";
}

startBtn.onclick = async () => {
  startBtn.disabled = true;
  startBtn.textContent = "Connecting…";
  errEl.hidden = true;
  try {
    lobby.hidden = true;
    callEl.hidden = false;
    await startCall(sessionId, { onEnd: showDone });
  } catch (err) {
    lobby.hidden = false;
    callEl.hidden = true;
    startBtn.disabled = false;
    startBtn.textContent = "Join interview";
    errEl.hidden = false;
    errEl.textContent = err.name === "NotAllowedError"
      ? "Microphone access is required to join. Please allow it and try again."
      : `Could not connect: ${err.message}`;
  }
};

loadInfo();
