const postingsEl = document.getElementById("postings");
const headingEl = document.getElementById("postings-heading");

async function load() {
  const resp = await fetch("/api/postings/public");
  const postings = await resp.json();
  if (!postings.length) {
    headingEl.hidden = true;
    postingsEl.innerHTML = `<div class="empty">No open roles right now — check back soon.</div>`;
    return;
  }
  headingEl.textContent = `Open roles (${postings.length})`;
  postingsEl.innerHTML = "";
  postings.forEach((p, i) => {
    const card = document.createElement("a");
    card.className = "posting-card";
    card.href = `/apply/${p.id}`;
    card.style.animationDelay = `${Math.min(i, 8) * 0.05}s`;
    card.innerHTML = `
      <h3></h3>
      <p></p>
      <span class="go">View role &amp; apply
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>
      </span>`;
    card.querySelector("h3").textContent = p.role;
    card.querySelector("p").textContent = p.jd_excerpt;
    postingsEl.appendChild(card);
  });
}

load();
