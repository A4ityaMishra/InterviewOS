// Candidate-facing join flow: Welcome -> Device check -> Ready -> Call -> Done.
// No JD form, no ops nav, no restart option after completion. The session
// already exists (created from the ops dashboard); this page only needs its
// id from the URL.

const sessionId = location.pathname.split("/").filter(Boolean).pop();

const dots = [...document.querySelectorAll("#dots .d")];
const stepWelcome = document.getElementById("step-welcome");
const stepCheck = document.getElementById("step-check");
const stepReady = document.getElementById("step-ready");
const rolePill = document.getElementById("role-pill");
const durText = document.getElementById("dur-text");
const toCheckBtn = document.getElementById("to-check");
const backToWelcomeBtn = document.getElementById("back-to-welcome");
const toReadyBtn = document.getElementById("to-ready");
const backToCheckBtn = document.getElementById("back-to-check");
const startBtn = document.getElementById("start");
const errWelcome = document.getElementById("err-welcome");
const errCheck = document.getElementById("err-check");
const micTest = document.getElementById("mic-test");
const micTestBars = [...micTest.querySelectorAll("i")];
const micStatus = document.getElementById("mic-status");
const deviceSelect = document.getElementById("device-select");
// callEl/doneCard etc. are declared once in call.js (loaded first)
const doneCard = document.getElementById("done");
const doneTitle = document.getElementById("done-title");
const doneSub = document.getElementById("done-sub");

const STEPS = ["welcome", "check", "ready"];
let previewStream = null;
let previewCtx = null;
let previewRaf = null;

function goToStep(name, direction = "forward") {
  for (const el of [stepWelcome, stepCheck, stepReady]) el.hidden = true;
  const el = { welcome: stepWelcome, check: stepCheck, ready: stepReady }[name];
  el.hidden = false;
  el.classList.toggle("back", direction === "back");
  // force reflow so the animation re-triggers even on repeat visits
  void el.offsetWidth;
  el.style.animation = "none";
  void el.offsetWidth;
  el.style.animation = "";

  const idx = STEPS.indexOf(name);
  dots.forEach((d, i) => {
    d.classList.toggle("active", i === idx);
    d.classList.toggle("done", i < idx);
  });
}

async function loadInfo() {
  try {
    const resp = await fetch(`/api/interviews/${sessionId}/public`);
    const info = await resp.json();
    if (info.error) throw new Error("not found");
    rolePill.textContent = info.role;
    durText.textContent = info.duration_min;
    document.getElementById("welcome-copy").textContent =
      `You've been invited to a short spoken interview for the ${info.role} role. It's a conversation, not a test of memorization — take your time and think out loud.`;
    if (info.status === "completed") {
      toCheckBtn.disabled = true;
      toCheckBtn.textContent = "This interview has already been completed";
    } else if (info.status === "live") {
      toCheckBtn.disabled = true;
      toCheckBtn.textContent = "This interview is already in progress";
    }
  } catch {
    stepWelcome.querySelector("h1").textContent = "This link isn't valid";
    stepWelcome.querySelector("p").textContent =
      "It may have expired or been copied incorrectly. Please check with your recruiter.";
    toCheckBtn.hidden = true;
    document.querySelector(".glyph").hidden = true;
    rolePill.hidden = true;
  }
}

// ---------- device check: live level meter via AnalyserNode ----------
function stopPreview() {
  if (previewRaf) cancelAnimationFrame(previewRaf);
  previewRaf = null;
  if (previewCtx) { previewCtx.close(); previewCtx = null; }
}

function meterLoop(analyser) {
  const data = new Uint8Array(analyser.fftSize);
  let peak = 0;
  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    peak = Math.max(rms, peak * 0.94); // slow-decay peak so bars don't flicker
    const lvl = Math.min(1, peak * 6);
    micTest.classList.toggle("live", lvl > 0.06);
    const active = Math.round(lvl * micTestBars.length);
    micTestBars.forEach((bar, i) => {
      bar.style.height = i < active ? `${16 + i * 6}px` : "8px";
    });
    if (lvl > 0.06 && toReadyBtn.disabled) {
      toReadyBtn.disabled = false;
      micStatus.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--green-deep)" stroke-width="2.4" stroke-linecap="round"><path d="M20 6L9 17l-5-5"/></svg> Looking good — we can hear you`;
    }
    previewRaf = requestAnimationFrame(tick);
  };
  tick();
}

async function startPreview(deviceId) {
  stopPreview();
  const constraints = {
    audio: deviceId
      ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
      : { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  };
  if (previewStream) previewStream.getTracks().forEach(t => t.stop());
  previewStream = await navigator.mediaDevices.getUserMedia(constraints);
  previewCtx = new AudioContext();
  const src = previewCtx.createMediaStreamSource(previewStream);
  const analyser = previewCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  meterLoop(analyser);
}

async function populateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === "audioinput");
  if (inputs.length > 1) {
    deviceSelect.innerHTML = inputs
      .map((d, i) => `<option value="${d.deviceId}">${d.label || `Microphone ${i + 1}`}</option>`)
      .join("");
    deviceSelect.hidden = false;
  }
}

async function enterCheckStep() {
  micStatus.innerHTML = `<span class="spin"></span> Requesting microphone access…`;
  toReadyBtn.disabled = true;
  errCheck.hidden = true;
  try {
    await startPreview();
    micStatus.textContent = "Say a few words…";
    await populateDevices();
  } catch (err) {
    micStatus.textContent = "";
    errCheck.hidden = false;
    errCheck.textContent = err.name === "NotAllowedError"
      ? "Microphone access was blocked. Enable it for this site in your browser's address-bar settings, then try again."
      : `Could not access your microphone: ${err.message}`;
  }
}

deviceSelect.onchange = () => startPreview(deviceSelect.value).catch(() => {});

toCheckBtn.onclick = () => { goToStep("check"); enterCheckStep(); };
backToWelcomeBtn.onclick = () => { stopPreview(); goToStep("welcome", "back"); };
toReadyBtn.onclick = () => goToStep("ready");
backToCheckBtn.onclick = () => { goToStep("check", "back"); enterCheckStep(); };

function showDone({ title, sub }) {
  if (previewStream) previewStream.getTracks().forEach(t => t.stop());
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
  try {
    stopPreview(); // tear down the meter's AudioContext, but keep the stream's tracks alive
    document.getElementById("wizard").hidden = true;
    callEl.hidden = false;
    await startCall(sessionId, { onEnd: showDone, existingStream: previewStream });
  } catch (err) {
    document.getElementById("wizard").hidden = false;
    callEl.hidden = true;
    startBtn.disabled = false;
    startBtn.textContent = "Join interview";
    alert(`Could not connect: ${err.message}`);
  }
};

loadInfo();
