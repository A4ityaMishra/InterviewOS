const accountsEl = document.getElementById("accounts");

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

let me = null;

async function loadMe() {
  const resp = await fetch("/api/auth/me");
  if (resp.status === 401) { window.location.href = "/login"; return; }
  me = await resp.json();
  document.getElementById("chip-name").textContent = me.name;
  const av = document.getElementById("chip-av");
  av.textContent = initials(me.name);
  av.style = avStyle(me.name);
  document.getElementById("user-chip").hidden = false;
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login";
});

async function loadAccounts() {
  const resp = await fetch("/api/accounts");
  if (resp.status === 401) { window.location.href = "/login"; return; }
  if (resp.status === 403) { window.location.href = "/welcome"; return; }
  const accounts = await resp.json();
  accounts.sort((a, b) => a.name.localeCompare(b.name));
  renderAccounts(accounts);
}

function renderAccounts(accounts) {
  accountsEl.innerHTML = "";
  if (!accounts.length) {
    accountsEl.innerHTML = `<div class="empty">No teammates yet.</div>`;
    return;
  }
  accounts.forEach((a, i) => {
    const isSelf = me && a.username === me.username;
    const row = document.createElement("div");
    row.className = "row";
    row.style.animationDelay = `${Math.min(i, 8) * 0.04}s`;
    row.innerHTML = `
      <div class="av"></div>
      <div class="info">
        <div class="name">
          <span class="name-text"></span>
          ${a.is_admin ? '<span class="tag admin">Admin</span>' : ""}
          ${isSelf ? '<span class="tag you">You</span>' : ""}
        </div>
        <div class="meta">@${a.username} · ${a.team} · joined ${fmtTime(a.created_at)}</div>
      </div>
      <div class="actions-row">
        <button class="icon-btn" title="Reset password" data-action="reset">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
        </button>
        <button class="icon-btn danger" title="Remove" data-action="remove" ${isSelf ? "disabled" : ""}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>`;
    row.querySelector(".av").style = avStyle(a.name);
    row.querySelector(".av").textContent = initials(a.name);
    row.querySelector(".name-text").textContent = a.name;
    row.querySelector('[data-action="reset"]').onclick = () => resetPassword(a);
    const removeBtn = row.querySelector('[data-action="remove"]');
    if (!isSelf) removeBtn.onclick = () => removeAccount(a);
    accountsEl.appendChild(row);
  });
}

async function resetPassword(account) {
  if (!confirm(`Reset the password for ${account.name}? Their current password will stop working immediately.`)) return;
  const resp = await fetch(`/api/accounts/${account.username}/reset-password`, { method: "POST" });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    showToast(body.detail || "Could not reset password.");
    return;
  }
  const data = await resp.json();
  document.getElementById("rs-name").textContent = account.name;
  document.getElementById("rs-password").value = data.password;
  const copyBtn = document.getElementById("rs-copy");
  copyBtn.textContent = "Copy";
  copyBtn.classList.remove("copied");
  document.getElementById("reset-scrim").hidden = false;
}

async function removeAccount(account) {
  if (!confirm(`Remove ${account.name}'s account? They'll no longer be able to sign in.`)) return;
  const resp = await fetch(`/api/accounts/${account.username}`, { method: "DELETE" });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    showToast(body.detail || "Could not remove that account.");
    return;
  }
  showToast(`${account.name} removed.`, "success");
  loadAccounts();
}

// ---------- add-teammate modal ----------
const scrim = document.getElementById("modal-scrim");
const newForm = document.getElementById("new-form");
const modalSubmit = document.getElementById("modal-submit");
const createErr = document.getElementById("create-err");
const createResult = document.getElementById("create-result");

function openModal() {
  scrim.hidden = false;
  newForm.hidden = false;
  createResult.hidden = true;
  createErr.hidden = true;
  newForm.reset();
}
function closeModal() { scrim.hidden = true; }

document.getElementById("new-btn").onclick = openModal;
document.getElementById("modal-cancel").onclick = closeModal;
scrim.onclick = (e) => { if (e.target === scrim) closeModal(); };
document.getElementById("create-done").onclick = () => { closeModal(); loadAccounts(); };

newForm.onsubmit = async (e) => {
  e.preventDefault();
  createErr.hidden = true;
  modalSubmit.disabled = true;
  modalSubmit.textContent = "Creating…";
  const fd = new FormData(newForm);
  try {
    const resp = await fetch("/api/accounts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: fd.get("name"),
        username: fd.get("username"),
        team: fd.get("team"),
        is_admin: fd.get("is_admin") === "on",
      }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      createErr.textContent = body.detail || "Could not create that account.";
      createErr.hidden = false;
      return;
    }
    const data = await resp.json();
    document.getElementById("cr-name").textContent = fd.get("name");
    document.getElementById("cr-username").value = data.username;
    document.getElementById("cr-password").value = data.password;
    const copyBtn = document.getElementById("cr-copy");
    copyBtn.textContent = "Copy";
    copyBtn.classList.remove("copied");
    newForm.hidden = true;
    createResult.hidden = false;
  } finally {
    modalSubmit.disabled = false;
    modalSubmit.textContent = "Create account";
  }
};

async function copyToClipboard(inputEl, btnEl) {
  inputEl.select();
  try {
    await navigator.clipboard.writeText(inputEl.value);
  } catch {
    document.execCommand("copy");
  }
  btnEl.textContent = "Copied";
  btnEl.classList.add("copied");
}
document.getElementById("cr-copy").onclick = () =>
  copyToClipboard(document.getElementById("cr-password"), document.getElementById("cr-copy"));
document.getElementById("rs-copy").onclick = () =>
  copyToClipboard(document.getElementById("rs-password"), document.getElementById("rs-copy"));

document.getElementById("reset-done").onclick = () => { document.getElementById("reset-scrim").hidden = true; };
document.getElementById("reset-scrim").onclick = (e) => {
  if (e.target === document.getElementById("reset-scrim")) e.currentTarget.hidden = true;
};

loadMe().then(loadAccounts);
