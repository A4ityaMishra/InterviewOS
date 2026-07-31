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
  if (me.team === "hr" || me.is_admin) document.getElementById("nav-hr").hidden = false;
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
    const isSelf = me && a.user_id === me.user_id;
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
        <div class="meta">${a.email} · ${a.team} · joined ${fmtTime(a.created_at)}</div>
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
  const resp = await fetch(`/api/accounts/${account.user_id}/reset-password`, { method: "POST" });
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
  const resp = await fetch(`/api/accounts/${account.user_id}`, { method: "DELETE" });
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
newForm.onsubmit = async (e) => {
  e.preventDefault();
  createErr.hidden = true;
  modalSubmit.disabled = true;
  modalSubmit.textContent = "Sending…";
  const fd = new FormData(newForm);
  try {
    const resp = await fetch("/api/accounts/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: fd.get("email"),
        team: fd.get("team"),
        is_admin: fd.get("is_admin") === "on",
      }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      createErr.textContent = body.detail || "Could not create that invite.";
      createErr.hidden = false;
      return;
    }
    const data = await resp.json();
    document.getElementById("cr-email-label").textContent = data.email;
    document.getElementById("cr-invite-url").value = data.invite_url;
    const copyBtn = document.getElementById("cr-copy");
    copyBtn.textContent = "Copy";
    copyBtn.classList.remove("copied");
    newForm.hidden = true;
    createResult.hidden = false;
  } finally {
    modalSubmit.disabled = false;
    modalSubmit.textContent = "Send invite";
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
  copyToClipboard(document.getElementById("cr-invite-url"), document.getElementById("cr-copy"));
document.getElementById("rs-copy").onclick = () =>
  copyToClipboard(document.getElementById("rs-password"), document.getElementById("rs-copy"));

document.getElementById("reset-done").onclick = () => { document.getElementById("reset-scrim").hidden = true; };
document.getElementById("reset-scrim").onclick = (e) => {
  if (e.target === document.getElementById("reset-scrim")) e.currentTarget.hidden = true;
};

// ---------- pending invites ----------
const invitesEl = document.getElementById("invites");
const invitesHeader = document.getElementById("invites-header");

async function loadInvites() {
  const resp = await fetch("/api/accounts/invites");
  if (!resp.ok) return;
  const invites = await resp.json();
  invitesHeader.hidden = invites.length === 0;
  invitesEl.innerHTML = "";
  invites.forEach((inv, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.style.animationDelay = `${Math.min(i, 8) * 0.04}s`;
    row.innerHTML = `
      <div class="av"></div>
      <div class="info">
        <div class="name"><span class="name-text"></span><span class="tag you">Pending</span></div>
        <div class="meta">${inv.team} · invited ${fmtTime(inv.created_at)}</div>
      </div>
      <div class="actions-row">
        <button class="icon-btn danger" title="Revoke invite" data-action="revoke">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>`;
    row.querySelector(".av").style = avStyle(inv.email);
    row.querySelector(".av").textContent = initials(inv.email);
    row.querySelector(".name-text").textContent = inv.email;
    row.querySelector('[data-action="revoke"]').onclick = () => revokeInvite(inv);
    invitesEl.appendChild(row);
  });
}

async function revokeInvite(invite) {
  if (!confirm(`Revoke the invite for ${invite.email}?`)) return;
  const resp = await fetch(`/api/accounts/invites/${invite.id}`, { method: "DELETE" });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    showToast(body.detail || "Could not revoke that invite.");
    return;
  }
  showToast(`Invite for ${invite.email} revoked.`, "success");
  loadInvites();
}

document.getElementById("create-done").onclick = () => { closeModal(); loadAccounts(); loadInvites(); };

loadMe().then(() => { loadAccounts(); loadInvites(); });
