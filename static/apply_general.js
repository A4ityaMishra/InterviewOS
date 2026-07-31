const formView = document.getElementById("form-view");
const doneCard = document.getElementById("done-card");

const dropInput = document.querySelector("#resume-drop input");
const dropLabel = document.querySelector("#resume-drop span");
dropInput.addEventListener("change", () => {
  dropLabel.textContent = dropInput.files[0] ? dropInput.files[0].name : dropLabel.dataset.empty;
});

const form = document.getElementById("apply-form");
const err = document.getElementById("apply-err");
const submitBtn = document.getElementById("apply-submit");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  err.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = "Submitting…";
  const fd = new FormData(form);
  // no job_id — the server treats a blank job_id as a general/speculative application
  try {
    const resp = await fetch("/api/applications", { method: "POST", body: fd });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      err.textContent = body.detail || "Couldn't submit your application. Try again.";
      err.hidden = false;
      return;
    }
    const firstName = (fd.get("applicant_name") || "").trim().split(/\s+/)[0];
    if (firstName) document.getElementById("done-name").textContent = firstName;
    formView.hidden = true;
    doneCard.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Send my application";
  }
});
