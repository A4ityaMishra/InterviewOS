/* Shared call runtime — used by both app.js (internal test room) and
 * join.js (candidate link). Expects the call.css markup to be present:
 * #call, #stage, #state, #timer, #caption, #self-tile, #mic-meter, #mute,
 * #panel-toggle, #end-call, #log.
 *
 * startCall(sessionId, { onEnd }) resolves once the WebSocket call is torn
 * down (either "end" from the server or the candidate hanging up). onEnd
 * receives {reason: "completed"|"left", title, sub} so the caller can render
 * its own closing screen.
 */

const stage = document.getElementById("stage");
const stateEl = document.getElementById("state");
const timerEl = document.getElementById("timer");
const logEl = document.getElementById("log");
const callEl = document.getElementById("call");
const muteBtn = document.getElementById("mute");
const endBtn = document.getElementById("end-call");
const captionEl = document.getElementById("caption");
const selfTile = document.getElementById("self-tile");
const micMeter = document.getElementById("mic-meter");
const panelToggle = document.getElementById("panel-toggle");

let ws, audioCtx, playCtx, micStream;
let playQueue = [];
let currentSource = null;
let playing = false;
let agentBubble = null;
let muted = false;
let timerInterval = null;

function setState(s, label) {
  stage.className = `stage ${s}`;
  stateEl.textContent = label;
}

function addMsg(cls, text) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = cls === "agent" ? "Interviewer" : "You";
  const body = document.createElement("span");
  body.className = "body";
  body.textContent = text;
  div.append(who, body);
  logEl.appendChild(div);
  logEl.scrollTop = logEl.scrollHeight;
  return body;
}

function setCaption(text) {
  if (text) {
    captionEl.textContent = text;
    captionEl.classList.add("show");
  } else {
    captionEl.classList.remove("show");
  }
}

function startTimer() {
  const t0 = Date.now();
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - t0) / 1000);
    timerEl.textContent =
      `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
}

// ---------- playback (queued WAV/MP3 sentences, flushable for barge-in) ----------
async function enqueueWav(base64Audio) {
  const bytes = Uint8Array.from(atob(base64Audio), c => c.charCodeAt(0));
  const buf = await playCtx.decodeAudioData(bytes.buffer);
  playQueue.push(buf);
  if (!playing) playNext();
}

function playNext() {
  const buf = playQueue.shift();
  if (!buf) { playing = false; return; }
  playing = true;
  currentSource = playCtx.createBufferSource();
  currentSource.buffer = buf;
  currentSource.connect(playCtx.destination);
  currentSource.onended = playNext;
  currentSource.start();
}

function flushPlayback() {
  playQueue = [];
  if (currentSource) {
    currentSource.onended = null;
    try { currentSource.stop(); } catch {}
    currentSource = null;
  }
  playing = false;
}

// ---------- mic capture: worklet ships float32 frames, we downsample ----------
const workletCode = `
class PCMSender extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm-sender", PCMSender);
`;

function downsampleTo16k(float32, fromRate) {
  const ratio = fromRate / 16000;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = float32[Math.floor(i * ratio)];
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return out;
}

function interviewLive() {
  return ws && ws.readyState === WebSocket.OPEN;
}

window.addEventListener("beforeunload", (e) => {
  if (interviewLive()) e.preventDefault();
});

muteBtn.onclick = () => {
  muted = !muted;
  muteBtn.classList.toggle("muted", muted);
  muteBtn.setAttribute("aria-pressed", String(muted));
  muteBtn.querySelector("small").textContent = muted ? "Unmute" : "Mute";
  selfTile.classList.toggle("muted", muted);
};

panelToggle.onclick = () => {
  const open = callEl.classList.toggle("panel-open");
  panelToggle.classList.toggle("active", open);
  panelToggle.setAttribute("aria-pressed", String(open));
};

function startCall(sessionId, { onEnd, existingStream }) {
  endBtn.onclick = () => {
    if (ws) ws.close();
    flushPlayback();
    clearInterval(timerInterval);
    onEnd({
      reason: "left",
      title: "Interview ended",
      sub: "You left the interview early.",
    });
  };

  return _run(sessionId, onEnd, existingStream);
}

async function _run(sessionId, onEnd, existingStream) {
  // reuse the stream from an earlier device-check step if one was passed in,
  // so the candidate isn't asked for mic permission a second time
  micStream = existingStream || await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const stream = micStream;

  audioCtx = new AudioContext();
  playCtx = new AudioContext();
  const blobUrl = URL.createObjectURL(new Blob([workletCode], { type: "application/javascript" }));
  await audioCtx.audioWorklet.addModule(blobUrl);
  const src = audioCtx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(audioCtx, "pcm-sender");
  src.connect(node);

  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?session=${sessionId}`);
  ws.binaryType = "arraybuffer";

  let meterTick = 0;
  node.port.onmessage = (e) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const pcm = downsampleTo16k(e.data, audioCtx.sampleRate);
    // when muted, send silence instead of nothing: the server's VAD needs a
    // continuous stream to detect end-of-turn and keep the STT channel alive
    if (muted) pcm.fill(0);
    ws.send(pcm.buffer);
    if (++meterTick % 8 === 0) {
      let sum = 0;
      for (let i = 0; i < pcm.length; i += 4) sum += Math.abs(pcm[i]);
      const lvl = Math.min(1, (sum / (pcm.length / 4)) / 6000);
      micMeter.style.setProperty("--lvl", lvl.toFixed(2));
    }
  };

  ws.onmessage = async (e) => {
    const m = JSON.parse(e.data);
    switch (m.type) {
      case "status":
        agentBubble = null;
        if (m.state === "thinking") { setState("thinking", "Thinking…"); setCaption(""); }
        else if (m.state === "speaking") setState("speaking", "Speaking — you can interrupt");
        else { setState("listening", "Listening…"); setCaption(""); }
        break;
      case "agent_text":
        if (!agentBubble) agentBubble = addMsg("agent", "");
        agentBubble.textContent += (agentBubble.textContent ? " " : "") + m.text;
        logEl.scrollTop = logEl.scrollHeight;
        setCaption(m.text);
        break;
      case "agent_audio":
        await enqueueWav(m.wav);
        break;
      case "transcript":
        addMsg("user", m.text);
        break;
      case "interrupt":
        flushPlayback();
        setState("listening", "Listening…");
        setCaption("");
        break;
      case "end": {
        setState("", "Wrapping up…");
        clearInterval(timerInterval);
        const waitForPlayback = setInterval(() => {
          if (!playing && playQueue.length === 0) {
            clearInterval(waitForPlayback);
            ws.close();
            onEnd({
              reason: "completed",
              title: "Interview complete",
              sub: "Thanks for your time — the team will review the conversation and follow up by email.",
            });
          }
        }, 300);
        break;
      }
    }
  };

  ws.onopen = () => { setState("thinking", "Connecting you with the interviewer…"); startTimer(); };
  ws.onclose = () => { setState("", "Session ended."); clearInterval(timerInterval); };
}
