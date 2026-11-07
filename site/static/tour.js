// The homepage's demo (parts/tour.html): pieces of the apps drawn in the
// page, and a tip that points at what to try next. Each part's steps are the
// <ol class="tour-steps"> under it, so without scripts the page shows the
// first part's screen and steps as a list (and a part a link names, by
// :target). With it, one part shows at a time, and each step says:
//   data-target   the [data-x] it points at, ringed
//   data-state    words for what's showing: elements whose data-show has
//                 one of them appear, and elements whose data-hide has one
//                 of them go away
//   data-advance  "click": clicking the target goes to the next step
//   data-place    where the tip sits: top, bottom, left, or right
//   data-anchor   optional: the [data-x] the tip sits beside, when that
//                 isn't the target (so it doesn't cover what it explains)
// A part with data-autoplay plays itself once when it comes into view, a
// pointer clicking through its steps up to the one marked
// data-autoplay-end, unless the device asks for less motion. It stops for
// good the moment the visitor clicks or types in it, and the Pause / Play
// button beside the tabs controls it. Links to /#family and the like open
// that part. The Tips switch hides the tips and rings and leaves a slim
// Back / Next bar under the screen; the browser remembers "off" on the
// device (the privacy policy says so). Nothing is sent anywhere. No
// innerHTML: the tip's words are copied from the step's own nodes.
(() => {
  "use strict";

  const parts = [...document.querySelectorAll(".tour-part")];
  if (parts.length === 0) return;
  // Without this, CSS shows a part a link names (:target), for no scripts.
  document.documentElement.dataset.tour = "on";
  const tabs = [...document.querySelectorAll("[data-tour-tab]")];
  const NARROW = 720;
  // How far the ring reaches past its element: outline-offset, width, and
  // the pulse.
  const RING = 9;
  const main = parts[0].parentElement;
  const lessMotion = matchMedia("(prefers-reduced-motion: reduce)");

  let tips = true;
  try {
    tips = localStorage.getItem("tourTips") !== "off";
  } catch {
    // Storage blocked: tips stay on.
  }

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)));
  const wordsOf = (s) => (s || "").split(/\s+/).filter(Boolean);
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v);
    }
    el.append(...kids);
    return el;
  }

  const tours = parts.map((part, index) => {
    const frame = part.querySelector(".tour-frame");
    const stage = part.querySelector(".tour-stage");
    const list = part.querySelector(".tour-steps");
    const steps = [...list.children];
    list.hidden = true;
    stage.dataset.tour = "on";

    const count = h("p", { class: "tour-count" });
    const text = h("p", { class: "tour-text" });
    const back = h("button", { type: "button", text: "Back" });
    const next = h("button", { type: "button", class: "go" });
    const bubble = h(
      "div",
      { class: "tour-bubble", role: "group", "aria-label": `Tip for the ${part.dataset.label}` },
      count,
      h("div", { "aria-live": "polite" }, text),
      h("div", { class: "tour-buttons" }, back, next),
    );
    frame.append(bubble);

    let at = 0;
    let target = null;
    const following = parts[index + 1];

    // On a narrow screen, a target can sit partly outside a strip that
    // scrolls sideways (a sidebar, a table): scroll the strip, not the page.
    function reveal(el) {
      for (let a = el.parentElement; a && a !== frame; a = a.parentElement) {
        const s = getComputedStyle(a);
        const across = /auto|scroll/.test(s.overflowX) && a.scrollWidth > a.clientWidth;
        const down = /auto|scroll/.test(s.overflowY) && a.scrollHeight > a.clientHeight;
        if (!across && !down) continue;
        const r = el.getBoundingClientRect();
        const c = a.getBoundingClientRect();
        if (across && r.left - RING < c.left) a.scrollLeft -= c.left - r.left + RING;
        else if (across && r.right + RING > c.right) a.scrollLeft += r.right - c.right + RING;
        if (down && r.top - RING < c.top) a.scrollTop -= c.top - r.top + RING;
        else if (down && r.bottom + RING > c.bottom) a.scrollTop += r.bottom - c.bottom + RING;
      }
    }

    // Whether something between the target and the frame cuts off the
    // ring (a screen's rounded, clipped edge): then it's drawn inside.
    function clipped(el) {
      const r = el.getBoundingClientRect();
      for (let a = el.parentElement; a && a !== frame; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === "visible" && s.overflowY === "visible") continue;
        const c = a.getBoundingClientRect();
        if (r.left - RING < c.left || r.right + RING > c.right || r.top - RING < c.top || r.bottom + RING > c.bottom) {
          return true;
        }
      }
      return false;
    }

    function go(i, fromTarget) {
      at = clamp(i, 0, steps.length - 1);
      const step = steps[at];
      const state = wordsOf(step.dataset.state);
      const any = (attr) => wordsOf(attr).some((w) => state.includes(w));
      for (const el of stage.querySelectorAll("[data-show]")) el.hidden = !any(el.dataset.show);
      for (const el of stage.querySelectorAll("[data-hide]")) el.hidden = any(el.dataset.hide);
      target?.classList.remove("tour-focus", "inset");
      target = stage.querySelector(`[data-x="${step.dataset.target}"]`);
      count.textContent = `${at + 1} of ${steps.length}`;
      text.replaceChildren(...[...step.childNodes].map((n) => n.cloneNode(true)));
      back.hidden = at === 0;
      const last = at === steps.length - 1;
      next.textContent = !last ? "Next" : following ? `Next: ${following.dataset.label}` : "Start over";
      place();
      auto?.onChange();
      // A click on the screen moved the tour on: keep the keyboard with the
      // tip, and on a phone, where the tip sits under the screen, show it.
      if (fromTarget) {
        next.focus({ preventScroll: true });
        if (bubble.classList.contains("docked")) bubble.scrollIntoView({ block: "nearest" });
      }
    }

    function place() {
      if (part.hidden) return;
      const step = steps[at];
      if (target) {
        reveal(target);
        target.classList.toggle("tour-focus", tips);
        target.classList.toggle("inset", tips && clipped(target));
      }
      if (!target || !tips || frame.clientWidth < NARROW) {
        bubble.classList.add("docked");
        bubble.style.left = "";
        bubble.style.top = "";
        return;
      }
      bubble.classList.remove("docked");
      const f = frame.getBoundingClientRect();
      const anchor = step.dataset.anchor ? stage.querySelector(`[data-x="${step.dataset.anchor}"]`) : target;
      const t = (anchor || target).getBoundingClientRect();
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      const gap = 16;
      const spots = {
        bottom: [t.left - f.left + t.width / 2 - bw / 2, t.bottom - f.top + gap],
        top: [t.left - f.left + t.width / 2 - bw / 2, t.top - f.top - bh - gap],
        right: [t.right - f.left + gap, t.top - f.top + t.height / 2 - bh / 2],
        left: [t.left - f.left - bw - gap, t.top - f.top + t.height / 2 - bh / 2],
      };
      // Above or below needs the room up or down; beside needs the room
      // across. The other way, the tip slides to stay in the frame.
      const fits = (p) => {
        const [x, y] = spots[p];
        return p === "top" || p === "bottom" ? y >= 0 && y + bh <= f.height : x >= 0 && x + bw <= f.width;
      };
      const wanted = step.dataset.place || "bottom";
      const flip = { top: "bottom", bottom: "top", left: "right", right: "left" }[wanted];
      const spot = [wanted, flip, "bottom", "top", "right", "left"].find(fits) || wanted;
      const x = clamp(spots[spot][0], 8, f.width - bw - 8);
      const y = clamp(spots[spot][1], 8, f.height - bh - 8);
      bubble.style.left = `${x}px`;
      bubble.style.top = `${y}px`;
      bubble.dataset.place = spot;
      const arrow =
        spot === "top" || spot === "bottom"
          ? clamp(t.left - f.left + t.width / 2 - x, 18, bw - 18)
          : clamp(t.top - f.top + t.height / 2 - y, 18, bh - 18);
      bubble.style.setProperty("--arrow", `${arrow}px`);
    }

    // Plays the part by itself: a pointer moves to each step's target and
    // clicks it, with time to read each tip, up to data-autoplay-end.
    function player() {
      const marked = steps.findIndex((s) => s.hasAttribute("data-autoplay-end"));
      const end = marked < 0 ? steps.length - 1 : marked;
      const pointer = h("span", { class: "tour-pointer", "aria-hidden": "true" }, h("i"));
      frame.append(pointer);
      let run = 0;
      let playing = false;
      let wanted = true;
      let seen = false;
      const reading = (step) => Math.min(5200, 1600 + step.textContent.length * 26);

      function aim(el) {
        const f = frame.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const x = r.left - f.left + Math.min(r.width / 2, 48);
        const y = r.top - f.top + r.height * 0.6;
        pointer.style.transform = `translate(${x}px, ${y}px)`;
      }

      async function play() {
        const mine = ++run;
        const alive = () => mine === run;
        playing = true;
        auto.onChange();
        if (!pointer.style.transform) {
          pointer.style.transform = `translate(${frame.clientWidth * 0.7}px, ${frame.clientHeight * 0.75}px)`;
        }
        pointer.classList.add("on");
        while (at < end) {
          await sleep(reading(steps[at]));
          if (!alive()) return;
          const step = steps[at];
          if (step.dataset.advance === "click" && target) {
            aim(target);
            await sleep(850);
            if (!alive()) return;
            pointer.classList.add("press");
            await sleep(200);
            pointer.classList.remove("press");
            if (!alive()) return;
          }
          go(at + 1);
        }
        await sleep(1200);
        if (!alive()) return;
        playing = false;
        wanted = false;
        pointer.classList.remove("on");
        auto.onChange();
      }

      function stop(forGood) {
        run++;
        if (forGood) wanted = false;
        playing = false;
        pointer.classList.remove("on", "press");
        auto.onChange();
      }

      // Starts by itself only while it's on screen, showing, and wanted.
      function maybe() {
        if (wanted && !playing && seen && !part.hidden && !lessMotion.matches && !document.hidden) play();
      }

      const auto = {
        onChange: () => {},
        get playing() {
          return playing;
        },
        get finished() {
          return at >= end;
        },
        stop,
        maybe,
        // The Play button, or "Watch it work": from where it is, or from
        // the start once it's done.
        start() {
          if (at >= end) go(0);
          wanted = true;
          play();
        },
      };

      new IntersectionObserver(
        ([entry]) => {
          seen = entry.isIntersecting;
          if (seen) setTimeout(maybe, 700);
          else if (playing) stop(false);
        },
        { threshold: 0.5 },
      ).observe(frame);
      document.addEventListener("visibilitychange", () => (document.hidden ? playing && stop(false) : maybe()));

      // The visitor takes over: their own clicks and keys end it.
      const takeOver = (e) => {
        if (e.isTrusted && (playing || wanted)) stop(true);
      };
      frame.addEventListener("pointerdown", takeOver, true);
      frame.addEventListener("keydown", takeOver, true);

      return auto;
    }

    stage.addEventListener("click", (e) => {
      if (steps[at].dataset.advance === "click" && target && target.contains(e.target)) go(at + 1, true);
    });
    back.addEventListener("click", () => go(at - 1));
    next.addEventListener("click", () => {
      if (at < steps.length - 1) go(at + 1);
      else if (following) show(following.id, { scroll: true, user: true });
      else go(0);
    });

    const auto = part.hasAttribute("data-autoplay") ? player() : null;
    return { id: part.id, part, go, place, auto, started: false };
  });

  // Beside the parts' tabs: Pause / Play for a part that plays itself, and
  // the Tips switch.
  const tabsNav = document.querySelector(".tour-tabs");
  const switcher = h(
    "button",
    { type: "button", class: "tour-tips", "aria-pressed": String(tips) },
    "Tips",
    h("span", { class: "tour-tips-switch", "aria-hidden": "true" }),
  );
  const playButton = h("button", { type: "button", class: "tour-play", hidden: "" });
  tabsNav?.after(h("div", { class: "tour-controls" }, playButton, switcher));

  const shown = () => tours.find((t) => !t.part.hidden);
  function showPlayer() {
    const auto = shown()?.auto;
    playButton.hidden = !auto;
    if (!auto) return;
    const label = auto.playing ? "Pause" : auto.finished ? "Replay" : "Play";
    playButton.dataset.state = label.toLowerCase();
    playButton.textContent = label;
    playButton.setAttribute("aria-label", `${label} the demo`);
  }
  for (const t of tours) if (t.auto) t.auto.onChange = showPlayer;
  playButton.addEventListener("click", () => {
    const auto = shown()?.auto;
    if (!auto) return;
    if (auto.playing) auto.stop(true);
    else auto.start();
  });

  function setTips(on) {
    tips = on;
    switcher.setAttribute("aria-pressed", String(on));
    main.dataset.tips = on ? "on" : "off";
    try {
      if (on) localStorage.removeItem("tourTips");
      else localStorage.setItem("tourTips", "off");
    } catch {
      // Storage blocked: the choice lasts until the page closes.
    }
    tours.forEach((t) => t.place());
  }
  switcher.addEventListener("click", () => setTips(!tips));
  main.dataset.tips = tips ? "on" : "off";

  // how.user: the visitor chose it (the address names it, and a part that
  // plays itself stops). how.scroll: bring the tabs into view.
  function show(id, how = {}) {
    for (const part of parts) part.hidden = part.id !== id;
    for (const tab of tabs) tab.setAttribute("aria-current", String(tab.dataset.tourTab === id));
    // On a phone the tabs are a strip that scrolls sideways: bring this one in.
    const active = tabs.find((t) => t.dataset.tourTab === id);
    if (active && tabsNav && tabsNav.scrollWidth > tabsNav.clientWidth) {
      const a = active.getBoundingClientRect();
      const n = tabsNav.getBoundingClientRect();
      if (a.left < n.left) tabsNav.scrollLeft -= n.left - a.left + 16;
      else if (a.right > n.right) tabsNav.scrollLeft += a.right - n.right + 16;
    }
    if (how.user) for (const t of tours) if (t.id !== id) t.auto?.stop(true);
    for (const t of tours) if (t.id !== id && t.auto?.playing) t.auto.stop(false);
    const tour = tours.find((t) => t.id === id);
    if (!tour.started) {
      tour.started = true;
      tour.go(0);
    } else {
      tour.place();
    }
    showPlayer();
    if (how.user && location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    if (how.scroll) (document.getElementById("demo") || tour.part).scrollIntoView({ block: "start" });
    tour.auto?.maybe();
  }

  for (const tab of tabs) {
    tab.addEventListener("click", (e) => {
      e.preventDefault();
      show(tab.dataset.tourTab, { user: true });
    });
  }

  // "Watch it work": the part that plays itself, from the start.
  for (const link of document.querySelectorAll("[data-watch]")) {
    link.addEventListener("click", () => {
      const tour = tours.find((t) => t.auto);
      if (!tour) return;
      show(tour.id);
      tour.auto.start();
    });
  }

  // A link to /#family, from another page or this one, opens that part.
  const named = () => parts.find((p) => `#${p.id}` === location.hash);
  addEventListener("hashchange", () => {
    const part = named();
    if (part) show(part.id, { scroll: true, user: true });
  });

  let frameRequest = 0;
  const replace = () => {
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(() => tours.forEach((t) => t.place()));
  };
  addEventListener("resize", replace);
  document.fonts?.ready.then(replace);

  const first = named();
  if (first) show(first.id, { scroll: true, user: true });
  else show(parts[0].id);
})();
