const appsEl = document.getElementById("apps");

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
const fmtTime = ts => new Date(ts * 1000).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });

const badgeClass = status => status === "approved" ? "completed" : status === "rejected" ? "disconnected" : "created";

async function loadMe() {
  const resp = await fetch("/api/auth/me");
  if (resp.status === 401) { window.location.href = "/portal/login"; return; }
  const me = await resp.json();
  document.getElementById("chip-name").textContent = me.name;
  const av = document.getElementById("chip-av");
  av.textContent = initials(me.name);
  av.style = avStyle(me.name);
  document.getElementById("user-chip").hidden = false;
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/portal/login";
});

async function loadApplications() {
  const resp = await fetch("/api/portal/applications");
  if (resp.status === 401) { window.location.href = "/portal/login"; return; }
  const apps = await resp.json();
  renderApps(apps);
}

function renderApps(apps) {
  appsEl.innerHTML = "";
  if (!apps.length) {
    appsEl.innerHTML = `
      <div class="empty">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
        <p>No applications yet.</p>
        <a class="btn-primary" href="/apply">Browse open roles</a>
      </div>`;
    return;
  }
  apps.forEach((a, i) => {
    const card = document.createElement("div");
    card.className = "app-card";
    card.style.animationDelay = `${Math.min(i, 8) * 0.05}s`;
    const canJoin = a.session_id && a.interview_status && a.interview_status !== "completed";
    card.innerHTML = `
      <div class="top">
        <div>
          <div class="role"></div>
          <div class="meta">Applied ${fmtTime(a.created_at)}</div>
        </div>
        <span class="badge ${badgeClass(a.status)}"></span>
      </div>
      ${a.status === "rejected" && a.rejection_reason
        ? `<div class="rejection">${a.rejection_reason}</div>` : ""}
      ${canJoin ? `
      <div class="join-row">
        <a class="btn-primary" href="/interview/${a.session_id}">Join your interview</a>
        <div class="join-note">${a.interview_status === "created" ? "Ready whenever you are." : "Interview in progress."}</div>
      </div>` : ""}
      ${a.session_id && a.interview_status === "completed" ? `<div class="join-note" style="margin-top:14px;">Interview completed — thanks for chatting with us.</div>` : ""}`;
    card.querySelector(".role").textContent = a.role;
    card.querySelector(".badge").textContent = a.status;
    appsEl.appendChild(card);
  });
}

loadMe().then(loadApplications);
