// App-wide "eye-candy" interaction layer: reactive fluid background, custom
// cursor, corner HUD readouts, magnetic buttons, card tilt, and a masked
// word-reveal helper. Loaded on every page; each piece degrades gracefully
// if its target markup isn't present, and the whole layer is inert under
// prefers-reduced-motion or a coarse (touch) pointer.
(function () {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const fineCursor = !coarsePointer && !reduceMotion;

  if (fineCursor) document.body.classList.add("fx-cursor");

  // ---------- masked word-reveal helper (called explicitly by page scripts
  // once text is final, to avoid racing async content like the welcome
  // greeting) ----------
  window.fxWordReveal = function (el) {
    if (!el || el.dataset.fxDone) return;
    const text = el.textContent;
    el.innerHTML = text
      .split(" ")
      .map((word, i) => `<span class="word"><span class="word-inner" style="animation-delay:${i * 0.08}s">${word}</span></span>`)
      .join(" ");
    el.dataset.fxDone = "1";
  };

  // ---------- reactive fluid canvas background ----------
  const canvas = document.getElementById("fx-canvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    const COLORS = [
      [90, 200, 250],   // #5ac8fa
      [0, 113, 227],    // #0071e3
      [0, 88, 176],     // #0058b0
    ];
    let w, h, dpr;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener("resize", resize);

    // two layers for depth: slow soft "clouds" behind faster, smaller
    // "sparks" that react more eagerly to the cursor — same blue family
    // throughout, just varied scale/speed so it reads as fluid rather than
    // a couple of static shapes drifting in unison
    const clouds = Array.from({ length: 4 }, (_, i) => ({
      x: Math.random() * w, y: Math.random() * h,
      r: 260 + Math.random() * 200,
      vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
      alpha: 0.13 + Math.random() * 0.04, pullMax: 0.01, pullK: 400,
      color: COLORS[i % COLORS.length],
    }));
    const sparks = Array.from({ length: 5 }, (_, i) => ({
      x: Math.random() * w, y: Math.random() * h,
      r: 50 + Math.random() * 55,
      vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5,
      alpha: 0.16 + Math.random() * 0.08, pullMax: 0.03, pullK: 900,
      color: COLORS[i % COLORS.length],
    }));
    const blobs = clouds.concat(sparks);

    let cursorX = w / 2, cursorY = h / 2, hasCursor = false;
    window.addEventListener("mousemove", (e) => {
      cursorX = e.clientX;
      cursorY = e.clientY;
      hasCursor = true;
    });

    function draw() {
      ctx.clearRect(0, 0, w, h);
      for (const b of blobs) {
        b.x += b.vx;
        b.y += b.vy;
        if (hasCursor) {
          const dx = cursorX - b.x, dy = cursorY - b.y;
          const dist = Math.hypot(dx, dy) || 1;
          const pull = Math.min(b.pullMax, b.pullK / (dist * dist));
          b.x += dx * pull;
          b.y += dy * pull;
        }
        // wrap around edges with margin so blobs re-enter smoothly
        const margin = b.r;
        if (b.x < -margin) b.x = w + margin;
        if (b.x > w + margin) b.x = -margin;
        if (b.y < -margin) b.y = h + margin;
        if (b.y > h + margin) b.y = -margin;

        const [r, g, bl] = b.color;
        const grad = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, b.r);
        grad.addColorStop(0, `rgba(${r}, ${g}, ${bl}, ${b.alpha})`);
        grad.addColorStop(1, `rgba(${r}, ${g}, ${bl}, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    let paused = false;
    if (reduceMotion) {
      draw(); // one static frame, no loop
    } else {
      (function loop() {
        if (!paused) draw();
        requestAnimationFrame(loop);
      })();
    }

    // pause the canvas + cursor/HUD while a live call is on screen (its own
    // rich visuals shouldn't compete, and real-time audio deserves the CPU)
    const callEl = document.getElementById("call");
    if (callEl) {
      const setPaused = () => {
        paused = !callEl.hidden;
        canvas.style.opacity = paused ? "0" : "1";
        document.querySelectorAll(".hud, #cursor-dot").forEach((el) => {
          el.style.display = paused ? "none" : "";
        });
      };
      setPaused();
      new MutationObserver(setPaused).observe(callEl, { attributes: true, attributeFilter: ["hidden"] });
    }
  }

  if (coarsePointer) return; // no mouse below this point

  // ---------- live clock HUD ----------
  const clockEl = document.getElementById("hud-clock");
  if (clockEl) {
    function tickClock() {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      const offsetH = -d.getTimezoneOffset() / 60;
      const sign = offsetH >= 0 ? "+" : "-";
      clockEl.innerHTML = `${hh}:${mm}:${ss} <b>GMT${sign}${Math.abs(offsetH)}</b>`;
      clockEl.classList.add("show");
    }
    tickClock();
    setInterval(tickClock, 1000);
  }

  // ---------- cursor coordinate HUD ----------
  const coordsEl = document.getElementById("hud-coords");

  // ---------- custom cursor dot (lerped follow + hover morph) ----------
  const dot = document.getElementById("cursor-dot");
  let mouseX = window.innerWidth / 2, mouseY = window.innerHeight / 2;
  let dotX = mouseX, dotY = mouseY;

  window.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    if (coordsEl) {
      coordsEl.innerHTML = `X ${String(Math.round(e.clientX)).padStart(4, "0")}&nbsp;&nbsp;Y ${String(Math.round(e.clientY)).padStart(4, "0")}`;
      coordsEl.classList.add("show");
    }
    if (dot) dot.classList.add("show");
  });

  if (dot && !reduceMotion) {
    function raf() {
      dotX += (mouseX - dotX) * 0.18;
      dotY += (mouseY - dotY) * 0.18;
      dot.style.transform = `translate(${dotX}px, ${dotY}px)`;
      requestAnimationFrame(raf);
    }
    requestAnimationFrame(raf);

    document.querySelectorAll("a, button, input, textarea, select, .card, .nav-card, .item, .row").forEach((el) => {
      el.addEventListener("mouseenter", () => dot.classList.add("hover"));
      el.addEventListener("mouseleave", () => dot.classList.remove("hover"));
    });
    document.querySelectorAll("input, textarea, select").forEach((el) => {
      el.addEventListener("mouseenter", () => dot.classList.add("text-mode"));
      el.addEventListener("mouseleave", () => dot.classList.remove("text-mode"));
    });
  } else if (dot) {
    dot.style.display = "none";
  }

  if (reduceMotion) return; // skip tilt + magnetic pull

  // ---------- card tilt toward cursor (only where one hero card exists) ----------
  const card = document.querySelector(".card");
  if (card) {
    card.style.transformStyle = "preserve-3d";
    card.addEventListener("mousemove", (e) => {
      const rect = card.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      card.style.transform = `perspective(900px) rotateY(${px * 4}deg) rotateX(${-py * 4}deg)`;
    });
    card.addEventListener("mouseleave", () => {
      card.style.transform = "perspective(900px) rotateY(0) rotateX(0)";
    });
  }

  // ---------- magnetic pull on every primary button on the page ----------
  document.querySelectorAll(".btn-primary, .new-btn").forEach((btn) => {
    btn.addEventListener("mousemove", (e) => {
      const rect = btn.getBoundingClientRect();
      const mx = e.clientX - (rect.left + rect.width / 2);
      const my = e.clientY - (rect.top + rect.height / 2);
      btn.style.setProperty("--mx", `${mx * 0.18}px`);
      btn.style.setProperty("--my", `${my * 0.35}px`);
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.setProperty("--mx", "0px");
      btn.style.setProperty("--my", "0px");
    });
  });
})();
