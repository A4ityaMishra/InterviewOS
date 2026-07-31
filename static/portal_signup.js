const form = document.getElementById("signup-form");
const err = document.getElementById("err");
const errText = document.getElementById("err-text");
const submitBtn = document.getElementById("submit-btn");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Creating account…";
  const fd = new FormData(form);
  try {
    const resp = await fetch("/api/portal/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: fd.get("name"),
        email: fd.get("email"),
        password: fd.get("password"),
      }),
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
    window.location.href = data.redirect || "/portal";
  } catch {
    errText.textContent = "Couldn't reach the server — try again.";
    err.hidden = false;
    submitBtn.disabled = false;
    submitBtn.textContent = "Create account";
  }
});
