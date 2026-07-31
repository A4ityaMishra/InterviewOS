const token = new URLSearchParams(window.location.search).get("token") || "";

const invalidCard = document.getElementById("invalid-card");
const formCard = document.getElementById("form-card");
const form = document.getElementById("signup-form");
const err = document.getElementById("err");
const errText = document.getElementById("err-text");
const submitBtn = document.getElementById("submit-btn");

async function init() {
  if (!token) { invalidCard.hidden = false; return; }
  const resp = await fetch(`/api/accounts/invite/${encodeURIComponent(token)}`);
  if (!resp.ok) { invalidCard.hidden = false; return; }
  const invite = await resp.json();
  document.getElementById("email-input").value = invite.email;
  document.getElementById("invite-sub").textContent =
    `You've been invited to join as ${invite.email} on the ${invite.team} team.`;
  formCard.hidden = false;
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  const fd = new FormData(form);
  if (fd.get("password") !== fd.get("confirm_password")) {
    errText.textContent = "Password and confirmation don't match.";
    err.hidden = false;
    return;
  }
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating account…";
  try {
    const resp = await fetch("/api/accounts/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, name: fd.get("name"), password: fd.get("password") }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      errText.textContent = body.detail || "Could not create your account.";
      err.hidden = false;
      submitBtn.disabled = false;
      submitBtn.textContent = "Create account";
      return;
    }
    const data = await resp.json();
    window.location.href = data.redirect || "/welcome";
  } catch {
    errText.textContent = "Couldn't reach the server — try again.";
    err.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Create account";
  }
});

init();
