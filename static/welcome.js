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

async function loadMe() {
  const resp = await fetch("/api/auth/me");
  if (resp.status === 401) { window.location.href = "/login"; return; }
  const user = await resp.json();
  const greeting = document.getElementById("greeting");
  greeting.textContent = `Welcome back, ${user.name}`;
  if (window.fxWordReveal) window.fxWordReveal(greeting);
  document.getElementById("chip-name").textContent = user.name;
  document.getElementById("acct-name").textContent = user.name;
  const av = document.getElementById("chip-av");
  av.textContent = initials(user.name);
  av.style = avStyle(user.name);
  document.getElementById("user-chip").hidden = false;
  if (user.is_admin) {
    document.getElementById("nav-team").hidden = false;
    document.getElementById("team-card").hidden = false;
  }
}

async function loadStats() {
  const resp = await fetch("/api/ops/sessions");
  if (resp.status === 401) return;
  const sessions = await resp.json();
  animateCount(document.getElementById("st-total"), sessions.length);
  animateCount(document.getElementById("st-live"), sessions.filter(s => s.status === "live").length);
  animateCount(document.getElementById("st-done"), sessions.filter(s => s.status === "completed").length);
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

loadMe();
loadStats();
