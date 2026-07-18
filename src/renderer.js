const DEFAULT_POSITION = "top-right";
const DEFAULT_DURATION = 6000; // ms; use 0 to make a notification sticky

let hoverCount = 0;
// Live cards keyed by group so repeats of the same alert update one card
// (bumping its count) instead of stacking new ones.
const cards = new Map();

function setHover(delta) {
  hoverCount = Math.max(0, hoverCount + delta);
  // Only capture the mouse while a card is actually hovered, so the rest of
  // the transparent overlay stays click-through.
  window.notifier.setInteractive(hoverCount > 0);
}

// --- Sound (Web Audio API) ---------------------------------------------
// Tones are synthesized in JS, so no audio files are bundled and nothing is
// fetched — this stays within the page CSP, which blocks external media.
let audioCtx = null;
function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// One tone on the ctx clock: starts at `at` (s), lasts `dur` (s). A short
// attack/release envelope avoids the click you'd get from a hard on/off.
function tone(ctx, at, dur, freq, gain) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.01);
  g.gain.setValueAtTime(gain, Math.max(at + 0.01, at + dur - 0.03));
  g.gain.linearRampToValueAtTime(0, at + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

// A few quick beeps, then silence. Fire-and-forget.
function playBeeps(count = 3) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;
  for (let i = 0; i < count; i++) tone(ctx, now + i * 0.18, 0.1, 880, 0.15);
}

// A repeating two-tone alarm that keeps ringing until the returned stop() is
// called (on dismiss / auto-dismiss). Best paired with a sticky card.
function startAlarm() {
  const ctx = getAudioCtx();
  if (!ctx) return () => {};
  let stopped = false;
  const ring = () => {
    if (stopped) return;
    const now = ctx.currentTime;
    tone(ctx, now, 0.18, 880, 0.18);
    tone(ctx, now + 0.22, 0.18, 660, 0.18);
  };
  ring();
  const timer = setInterval(ring, 900);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function playSound(sound, card) {
  if (sound === "beep") {
    playBeeps();
  } else if (sound === "alarm") {
    // One continuous alarm per group; repeats bump the count, not the ringers.
    if (!card._stopAlarm) card._stopAlarm = startAlarm();
  }
}

function zoneFor(position) {
  const pos = String(position || DEFAULT_POSITION);
  return (
    document.querySelector(`.zone[data-pos="${pos}"]`) ||
    document.querySelector(`.zone[data-pos="${DEFAULT_POSITION}"]`)
  );
}

function applyStyle(card, style) {
  if (!style || typeof style !== "object") return;
  const map = {
    background: "background",
    color: "color",
    width: "width",
    borderRadius: "borderRadius",
    fontFamily: "fontFamily",
    fontSize: "fontSize",
    padding: "padding",
    boxShadow: "boxShadow",
    opacity: "opacity",
  };
  for (const [key, cssProp] of Object.entries(map)) {
    if (style[key] != null) card.style[cssProp] = String(style[key]);
  }
  if (style.accent != null) {
    card.style.borderLeftColor = String(style.accent);
  }
}

// Builds the icon+text (or raw html) block for a card.
function buildMain(payload) {
  const main = document.createElement("div");
  main.className = "main";

  if (typeof payload.html === "string") {
    // Full custom web design supplied as JSON. The page CSP blocks scripts,
    // so injected markup can style but cannot execute.
    main.innerHTML = payload.html;
    return main;
  }

  const icon = document.createElement("div");
  icon.className = "icon";
  icon.textContent = payload.icon || "";
  if (!payload.icon) icon.style.display = "none";

  const content = document.createElement("div");
  content.className = "content";
  if (payload.title) {
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = payload.title;
    content.appendChild(title);
  }
  if (payload.body) {
    const body = document.createElement("div");
    body.className = "body";
    body.textContent = payload.body;
    content.appendChild(body);
  }

  main.appendChild(icon);
  main.appendChild(content);
  return main;
}

// Shows the repeat counter once an alert has fired more than once.
function setBadge(card, count) {
  let badge = card.querySelector(".badge");
  if (count > 1) {
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "badge";
      card.appendChild(badge);
    }
    badge.textContent = count > 99 ? "99+" : String(count);
  } else if (badge) {
    badge.remove();
  }
}

// (Re)starts the auto-dismiss timer + progress bar for a card.
function armAutoDismiss(card, payload) {
  if (card._dismissTimer) {
    clearTimeout(card._dismissTimer);
    card._dismissTimer = null;
  }
  const oldProgress = card.querySelector(".progress");
  if (oldProgress) oldProgress.remove();

  const duration =
    payload.duration === 0 || payload.duration === "0"
      ? 0
      : Number(payload.duration) || DEFAULT_DURATION;
  if (duration <= 0) return;

  const accent = payload.style && payload.style.accent;
  const progress = document.createElement("div");
  progress.className = "progress";
  if (accent) progress.style.background = String(accent);
  progress.style.transition = `width ${duration}ms linear`;
  progress.style.width = "100%";
  card.appendChild(progress);
  requestAnimationFrame(() => (progress.style.width = "0%"));

  card._dismissTimer = setTimeout(() => dismiss(card), duration);
}

// Briefly flash a card to signal a repeat arrival.
function pulse(card) {
  card.classList.remove("pulse");
  void card.offsetWidth; // reflow so the animation restarts
  card.classList.add("pulse");
}

function dismiss(card) {
  if (card.dataset.dismissing) return;
  card.dataset.dismissing = "1";
  if (typeof card._stopAlarm === "function") card._stopAlarm();
  if (card._dismissTimer) clearTimeout(card._dismissTimer);
  if (card._groupKey) {
    cards.delete(card._groupKey);
    window.notifier.dismissGroup(card._groupKey);
  }
  if (card.dataset.hovered === "1") setHover(-1);
  card.classList.remove("show");
  card.classList.add("hide");
  setTimeout(() => card.remove(), 280);
}

function render(payload) {
  if (!payload || typeof payload !== "object") return;

  const groupKey = payload._groupKey || null;
  const count = payload._count || 1;
  const appId = payload._appId || "default";
  const silent = !!payload._silent;

  // Repeat of a live alert: update the existing card in place.
  const existing = groupKey ? cards.get(groupKey) : null;
  if (existing && !existing.dataset.dismissing) {
    existing.querySelector(".main").replaceWith(buildMain(payload));
    applyStyle(existing, payload.style);
    setBadge(existing, count);
    armAutoDismiss(existing, payload);
    pulse(existing);
    if (!silent) playSound(payload.sound, existing);
    return;
  }

  const card = document.createElement("div");
  card.className = "card";
  card._groupKey = groupKey;
  card._appId = appId;

  const accent = payload.style && payload.style.accent;

  card.appendChild(buildMain(payload));

  const actions = document.createElement("div");
  actions.className = "actions";

  const snoozeBtn = document.createElement("button");
  snoozeBtn.className = "act";
  snoozeBtn.title = "Snooze this app for 1 hour";
  snoozeBtn.textContent = "⏱"; // stopwatch
  snoozeBtn.addEventListener("click", () => {
    window.notifier.snooze(card._appId);
    dismiss(card);
  });

  const muteBtn = document.createElement("button");
  muteBtn.className = "act";
  muteBtn.title = "Mute this app";
  muteBtn.textContent = "🔇"; // muted speaker
  muteBtn.addEventListener("click", () => {
    window.notifier.muteApp(card._appId);
    dismiss(card);
  });

  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  if (accent) close.style.color = String(accent);
  close.addEventListener("click", () => dismiss(card));

  actions.appendChild(snoozeBtn);
  actions.appendChild(muteBtn);
  actions.appendChild(close);
  card.appendChild(actions);

  applyStyle(card, payload.style);
  setBadge(card, count);

  card.addEventListener("mouseenter", () => {
    card.dataset.hovered = "1";
    setHover(1);
  });
  card.addEventListener("mouseleave", () => {
    if (card.dataset.hovered === "1") {
      card.dataset.hovered = "0";
      setHover(-1);
    }
  });

  const zone = zoneFor(payload.position);
  zone.appendChild(card);
  if (groupKey) cards.set(groupKey, card);
  requestAnimationFrame(() => card.classList.add("show"));

  armAutoDismiss(card, payload);
  if (!silent) playSound(payload.sound, card);
}

window.notifier.onNotification(render);
