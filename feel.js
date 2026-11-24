/* TheraChart "feel" layer — how the app responds to a touch, not what it does.
 *
 *   navigate(from, to, update)  page transitions: deeper slides in from the right,
 *                               back slides out, sibling tabs slide sideways —
 *                               always horizontally. Uses the browser's View Transitions;
 *                               anything without them (or with reduced motion on)
 *                               just runs update() — a plain swap, as before.
 *   press feedback              every tappable thing sinks a little under the
 *                               finger and springs back on release.
 *   signed()                    the Sign & lock moment: a pop, a haptic tap and a
 *                               seal that draws itself, then gets out of the way.
 *   sounds on/off               per device, from My Profile. A clinic is a quiet
 *                               room with a patient in it; the pop must be mutable.
 *
 * Nothing here touches clinical data, and every piece fails silent: a browser
 * that can't do one of these things gets the app exactly as it was. */
(function () {
  "use strict";

  const reduceMotion = () => !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const root = document.documentElement;

  /* ---------------- sound ---------------- */
  const LS_SOUNDS = "therachart.feel.sounds";
  const soundsOn = () => { try { return localStorage.getItem(LS_SOUNDS) !== "off"; } catch (_) { return true; } };
  const setSounds = (on) => { try { localStorage.setItem(LS_SOUNDS, on ? "on" : "off"); } catch (_) { } };

  let ctx = null;
  /* iOS only lets audio start inside a user gesture. Call prime() at the very
     top of a click handler, before any await, so the context is already running
     when the sound plays after a network round trip. */
  function prime() {
    if (!soundsOn()) return null;
    try {
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === "suspended") ctx.resume();
    } catch (_) { ctx = null; }
    return ctx;
  }

  // one enveloped oscillator: a quick attack and an exponential tail
  function tone(ac, { type = "sine", f0, f1, at = 0, dur, gain }) {
    const t = ac.currentTime + at;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.6);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ac.destination);
    o.start(t); o.stop(t + dur + 0.02);
  }

  // a short filtered noise burst: the "tick" of a latch, a pen click, a stamp
  function click(ac, { at = 0, dur = 0.014, freq = 2400, q = 1.1, gain = 0.14 }) {
    const t = ac.currentTime + at;
    const len = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = buf; bp.type = "bandpass"; bp.frequency.value = freq; bp.Q.value = q;
    g.gain.value = gain;
    src.connect(bp).connect(g).connect(ac.destination);
    src.start(t);
  }

  /* The sign sound: a soft mechanical latch — a dry click with a low, felted
     thud under it, like a stamp landing or a lock closing — and one quiet,
     low confirming tone. No rising notes and no bright harmonics: those are
     what make a sound read as "coin collected" rather than "record sealed".
     Synthesised, so there is no audio file to cache or fail to load. */
  function playPop() {
    const ac = prime();
    if (!ac) return;
    try {
      click(ac, { freq: 2600, gain: 0.12 });
      tone(ac, { f0: 165, f1: 82, dur: 0.14, gain: 0.34 });
      click(ac, { at: 0.055, freq: 1500, dur: 0.01, gain: 0.07 });
      tone(ac, { f0: 440, at: 0.06, dur: 0.42, gain: 0.035 });
    } catch (_) { }
  }

  /* ---------------- haptics ----------------
     Android: the Vibration API. iPhone: Safari has none, but iOS 18 gives a
     system haptic when a switch-style checkbox is toggled through its label —
     a workaround, so it may stop working in a later iOS; it fails silent. */
  let iosSwitch = null;
  function haptic(pattern) {
    try {
      if (navigator.vibrate) { navigator.vibrate(pattern); return; }
      if (!/iP(hone|ad|od)/.test(navigator.userAgent)) return;
      if (!iosSwitch) {
        iosSwitch = document.createElement("label");
        iosSwitch.setAttribute("aria-hidden", "true");
        iosSwitch.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden;opacity:0";
        const input = document.createElement("input");
        input.type = "checkbox"; input.setAttribute("switch", ""); input.tabIndex = -1;
        iosSwitch.appendChild(input);
        document.body.appendChild(iosSwitch);
      }
      iosSwitch.click();
    } catch (_) { }
  }

  /* ---------------- press feedback ----------------
     Web Animations on the independent `scale` property, so an element's own
     transform (a hover lift, a rotate) is left alone and no CSS transition list
     has to be rewritten per component. Big targets sink less than small ones —
     a whole card shrinking 4% reads as a glitch, not a press. */
  const PRESSABLE = 'button, a[href], [data-href], tr.rowlink, summary, [role="tab"], label.chk, .tab';
  const SKIP = "input, textarea, select, svg .marker, .point-group, [data-no-press], .tabbar .tab-pill";
  let pressed = null;
  function depthFor(el) {
    const w = el.getBoundingClientRect().width;
    return w > 420 ? 0.985 : w > 200 ? 0.97 : 0.94;
  }
  function pressDown(e) {
    if (e.button > 0 || reduceMotion()) return;
    const t = e.target;
    if (!t.closest || t.closest(SKIP)) return;
    const el = t.closest(PRESSABLE);
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true" || !el.animate) return;
    release();
    const s = depthFor(el);
    pressed = { el, s };
    try { el.animate([{ scale: 1 }, { scale: s }], { duration: 90, easing: "cubic-bezier(.3,.7,.4,1)", fill: "forwards" }); } catch (_) { pressed = null; }
    if (el.classList.contains("tab")) haptic(6);
  }
  function release() {
    if (!pressed) return;
    const { el, s } = pressed;
    pressed = null;
    try {
      el.getAnimations().forEach((a) => a.cancel());
      el.animate([{ scale: s }, { scale: 1.012 }, { scale: 1 }], { duration: 260, easing: "cubic-bezier(.2,.9,.3,1.2)" });
    } catch (_) { }
  }
  document.addEventListener("pointerdown", pressDown, { passive: true });
  ["pointerup", "pointercancel", "dragstart"].forEach((ev) => document.addEventListener(ev, release, { passive: true }));
  document.addEventListener("pointermove", (e) => {
    // a finger that started on a button and is now scrolling isn't pressing it
    if (pressed && e.pointerType !== "mouse" && !pressed.el.contains(document.elementFromPoint(e.clientX, e.clientY))) release();
  }, { passive: true });

  /* ---------------- page transitions ---------------- */
  // The app is a stack: tab-level screens, a chart above them, a note above that.
  const TAB_ORDER = ["dashboard", "patients", "calendar", "drafts", "visit-time", "privacy", "facility", "clinics", "profile"];
  const routeOf = (h) => ((h || "").replace(/^#\//, "").split("/")[0] || "dashboard").split("?")[0];
  const signedOut = (h) => h === "#/signin" || h === "" || h === "#/" || h === "#";
  function depth(h) {
    const r = routeOf(h);
    if (r === "doc") return 2;
    if (r === "intake") return /\?edit=/.test(h) ? 2 : 1;
    if (r === "patient") return 1;
    if (r === "patients" && /\?all=1/.test(h)) return 1; // the full list sits above search
    return 0;
  }
  function directionFor(from, to) {
    if (signedOut(from) || signedOut(to)) return "fade";
    const d = depth(to) - depth(from);
    if (d > 0) return "fwd";
    if (d < 0) return "back";
    const a = TAB_ORDER.indexOf(routeOf(from)), b = TAB_ORDER.indexOf(routeOf(to));
    if (a >= 0 && b >= 0 && a !== b) return b > a ? "right" : "left";
    return "fade";
  }
  let running = null;
  function navigate(from, to, update) {
    const can = typeof document.startViewTransition === "function" && !reduceMotion() && !document.hidden;
    if (!can) { update(); return; }
    if (running) { try { running.skipTransition(); } catch (_) { } }
    const dir = directionFor(from, to);
    root.classList.remove("vt-fwd", "vt-back", "vt-left", "vt-right", "vt-fade");
    root.classList.add("vt-on", "vt-" + dir);
    let vt;
    try {
      vt = document.startViewTransition(update);
    } catch (_) {
      root.classList.remove("vt-on", "vt-" + dir);
      update(); return;
    }
    running = vt;
    // belt and braces: a transition that stalls (tab backgrounded mid-way) is
    // cut short rather than leaving the page frozen on a snapshot
    setTimeout(() => { if (running === vt) { try { vt.skipTransition(); } catch (_) { } } }, 1500);
    vt.finished.finally(() => {
      if (running !== vt) return;
      running = null;
      root.classList.remove("vt-on", "vt-fwd", "vt-back", "vt-left", "vt-right", "vt-fade");
    });
  }

  /* ---------------- the Sign & lock moment ---------------- */
  const SEAL_SVG = `<svg class="seal-lock" viewBox="0 0 48 48" aria-hidden="true">
    <path class="seal-shackle" d="M16 22v-6a8 8 0 0 1 16 0v6" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/>
    <rect x="11" y="21" width="26" height="20" rx="5" fill="#fff"/>
    <path class="seal-check" d="M18 31.5l4.2 4.2L30.5 27" fill="none" stroke="#0e7c86" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  function signed(label) {
    if (soundsOn()) playPop();
    haptic([10, 40, 18]);
    const el = document.createElement("div");
    el.className = "seal" + (reduceMotion() ? " still" : "");
    el.setAttribute("role", "status");
    el.innerHTML = `<div class="seal-ring"></div><div class="seal-badge">${SEAL_SVG}</div><div class="seal-label">${label || "Signed &amp; locked"}</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add("out"), reduceMotion() ? 900 : 1150);
    setTimeout(() => el.remove(), reduceMotion() ? 1200 : 1500);
  }

  window.TheraFeel = { navigate, signed, prime, playPop, haptic, soundsOn, setSounds, directionFor };
})();
