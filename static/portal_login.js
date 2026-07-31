const modePassword = document.getElementById("mode-password");
const modeCode = document.getElementById("mode-code");
const passwordForm = document.getElementById("password-form");
const codeRequestForm = document.getElementById("code-request-form");
const codeVerifyForm = document.getElementById("code-verify-form");

function showMode() {
  const wantsCode = modeCode.checked;
  passwordForm.hidden = wantsCode;
  codeRequestForm.hidden = !wantsCode;
  codeVerifyForm.hidden = true;
}
modePassword.addEventListener("change", showMode);
modeCode.addEventListener("change", showMode);

async function goToPortal(resp) {
  const data = await resp.json();
  window.location.href = data.redirect || "/portal";
}

// ---------- password sign-in ----------
const pwErr = document.getElementById("pw-err");
const pwErrText = document.getElementById("pw-err-text");
const submitBtn = document.getElementById("submit-btn");

passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  pwErr.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Signing in…";
  const fd = new FormData(passwordForm);
  try {
    const resp = await fetch("/api/portal/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      pwErrText.textContent = body.detail || "Invalid email or password.";
      pwErr.hidden = false;
      return;
    }
    await goToPortal(resp);
  } catch (err) {
    console.error("Login error:", err);
    pwErrText.textContent = "Something went wrong. Please try again.";
    pwErr.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Sign in";
  }
});

// ---------- email code sign-in ----------
const codeReqErr = document.getElementById("code-req-err");
const codeReqErrText = document.getElementById("code-req-err-text");
const codeRequestBtn = document.getElementById("code-request-btn");
const codeSentMsg = document.getElementById("code-sent-msg");
let pendingEmail = "";

codeRequestForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  codeReqErr.hidden = true;
  codeRequestBtn.disabled = true;
  codeRequestBtn.textContent = "Sending…";
  const fd = new FormData(codeRequestForm);
  pendingEmail = fd.get("email");
  try {
    const resp = await fetch("/api/portal/auth/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pendingEmail }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      codeReqErrText.textContent = body.detail || "Could not send a code.";
      codeReqErr.hidden = false;
      return;
    }
    codeSentMsg.textContent = `If ${pendingEmail} has an account, a 6-digit code was sent — check your inbox.`;
    codeRequestForm.hidden = true;
    codeVerifyForm.hidden = false;
  } catch (err) {
    console.error("Code request error:", err);
    codeReqErrText.textContent = "Something went wrong. Please try again.";
    codeReqErr.hidden = false;
  } finally {
    codeRequestBtn.disabled = false;
    codeRequestBtn.textContent = "Send code";
  }
});

const codeVerifyErr = document.getElementById("code-verify-err");
const codeVerifyErrText = document.getElementById("code-verify-err-text");
const codeVerifyBtn = document.getElementById("code-verify-btn");

codeVerifyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  codeVerifyErr.hidden = true;
  codeVerifyBtn.disabled = true;
  codeVerifyBtn.textContent = "Verifying…";
  const fd = new FormData(codeVerifyForm);
  try {
    const resp = await fetch("/api/portal/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: pendingEmail, code: fd.get("code") }),
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      codeVerifyErrText.textContent = body.detail || "Invalid or expired code.";
      codeVerifyErr.hidden = false;
      return;
    }
    await goToPortal(resp);
  } catch (err) {
    console.error("Code verify error:", err);
    codeVerifyErrText.textContent = "Something went wrong. Please try again.";
    codeVerifyErr.hidden = false;
  } finally {
    codeVerifyBtn.disabled = false;
    codeVerifyBtn.textContent = "Verify & sign in";
  }
});

document.getElementById("code-back-btn").addEventListener("click", () => {
  codeVerifyForm.hidden = true;
  codeRequestForm.hidden = false;
});
