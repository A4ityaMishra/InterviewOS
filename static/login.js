const form = document.getElementById("login-form");
const err = document.getElementById("err");
const errText = document.getElementById("err-text");
const submitBtn = document.getElementById("submit-btn");
const pwInput = document.getElementById("pw-input");
const pwToggle = document.getElementById("pw-toggle");

pwToggle.addEventListener("click", () => {
  const showing = pwInput.type === "text";
  pwInput.type = showing ? "password" : "text";
  pwToggle.setAttribute("aria-pressed", String(!showing));
  pwToggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
});

function setError(message) {
  errText.textContent = message;
  err.hidden = false;
}

function resetSubmit() {
  submitBtn.disabled = false;
  submitBtn.textContent = "Sign in";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in…";
  const fd = new FormData(form);
  try {
    const resp = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: fd.get("username"),
        password: fd.get("password"),
      }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      setError(body.detail || "Invalid username or password.");
      resetSubmit();
      form.username.focus();
      return;
    }
    const data = await resp.json();
    submitBtn.classList.add("success");
    submitBtn.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg> Signed in';
    setTimeout(() => { window.location.href = data.redirect || "/welcome"; }, 320);
  } catch {
    setError("Couldn't reach the server — try again.");
    resetSubmit();
  }
});
