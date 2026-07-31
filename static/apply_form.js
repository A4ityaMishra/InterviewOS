const jobId = window.location.pathname.split("/").pop();

const loadingCard = document.getElementById("loading-card");
const invalidCard = document.getElementById("invalid-card");
const roleContent = document.getElementById("role-content");
const doneCard = document.getElementById("done-card");
const subbar = document.getElementById("subbar");
const mobileApplyBar = document.getElementById("mobile-apply-bar");

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// Turns plain-text JD content into readable HTML: blank-line-separated blocks,
// a short first line with more lines after it becomes a heading, and blocks
// where every line starts with "-"/"*" become a bullet list. JDs are free-text
// uploads/pastes with no markup, so this is a light heuristic, not a parser —
// worst case a block just renders as a plain paragraph, never broken markup.
function formatJdText(raw, role) {
  let text = raw.trim();
  // JDs often lead with a standalone title line repeating the role name —
  // that's already shown in the page's <h1>, so drop it to avoid duplication
  const firstLine = text.split("\n")[0].trim();
  if (role && firstLine.toLowerCase() === role.trim().toLowerCase()) {
    text = text.slice(text.indexOf("\n") + 1).trim();
  }
  const blocks = text.split(/\n\s*\n/);
  let html = "";
  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    const isHeading = lines.length > 1 && lines[0].length < 60 && !/[.:]$/.test(lines[0]) && !/^[-*]/.test(lines[0]);
    let bodyLines = lines;
    if (isHeading) {
      html += `<h3>${escapeHtml(lines[0])}</h3>`;
      bodyLines = lines.slice(1);
    }
    if (!bodyLines.length) continue;

    const isBulletList = bodyLines.every(l => /^[-*]\s+/.test(l));
    if (isBulletList) {
      html += "<ul>" + bodyLines.map(l => `<li>${escapeHtml(l.replace(/^[-*]\s+/, ""))}</li>`).join("") + "</ul>";
    } else {
      html += `<p>${escapeHtml(bodyLines.join(" "))}</p>`;
    }
  }
  return html;
}

async function loadPosting() {
  const resp = await fetch(`/api/postings/${jobId}/public`);
  const data = await resp.json();
  loadingCard.hidden = true;
  if (data.error) {
    invalidCard.hidden = false;
    return;
  }
  subbar.hidden = false;
  document.title = `Apply — ${data.role} — InterviewOS`;
  document.getElementById("role-title").textContent = data.role;
  document.getElementById("jd-prose").innerHTML = formatJdText(data.jd_text, data.role);
  roleContent.hidden = false;
  mobileApplyBar.hidden = false;
  if (window.fxWordReveal) window.fxWordReveal(document.getElementById("role-title"));
}

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
  fd.set("job_id", jobId);
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
    subbar.hidden = true;
    mobileApplyBar.hidden = true;
    roleContent.hidden = true;
    doneCard.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit application";
  }
});

loadPosting();
