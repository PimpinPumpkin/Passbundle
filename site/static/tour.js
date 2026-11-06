// The tour (/tour/): pieces of the apps drawn in the page, and a tip that
// points at what to try next. Each part's steps are the <ol class="tour-steps">
// under it, so without scripts the page shows the screens and the steps as a
// list. With it, one part shows at a time, and each step says:
//   data-target   the [data-x] it points at, ringed
//   data-state    words for what's showing: elements with data-show="word"
//                 appear, and elements with data-hide="word" go away
//   data-advance  "click": clicking the target goes to the next step
//   data-place    where the tip sits: top, bottom, left, or right
//   data-anchor   optional: the [data-x] the tip sits beside, when that
//                 isn't the target (so it doesn't cover what it explains)
// Nothing is stored or sent anywhere. No innerHTML: the tip's words are
// copied from the step's own nodes.
(() => {
  "use strict";

  const parts = [...document.querySelectorAll(".tour-part")];
  if (parts.length === 0) return;
  const tabs = [...document.querySelectorAll("[data-tour-tab]")];
  const NARROW = 720;

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, Math.max(lo, hi)));

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

    function go(i, fromTarget) {
      at = clamp(i, 0, steps.length - 1);
      const step = steps[at];
      const words = (step.dataset.state || "").split(/\s+/).filter(Boolean);
      for (const el of stage.querySelectorAll("[data-show]")) el.hidden = !words.includes(el.dataset.show);
      for (const el of stage.querySelectorAll("[data-hide]")) el.hidden = words.includes(el.dataset.hide);
      target?.classList.remove("tour-focus");
      target = stage.querySelector(`[data-x="${step.dataset.target}"]`);
      target?.classList.add("tour-focus");
      count.textContent = `${at + 1} of ${steps.length}`;
      text.replaceChildren(...[...step.childNodes].map((n) => n.cloneNode(true)));
      back.hidden = at === 0;
      const last = at === steps.length - 1;
      next.textContent = !last ? "Next" : following ? `Next: ${following.dataset.label}` : "Start over";
      place();
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
      if (!target || frame.clientWidth < NARROW) {
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

    stage.addEventListener("click", (e) => {
      if (steps[at].dataset.advance === "click" && target && target.contains(e.target)) go(at + 1, true);
    });
    back.addEventListener("click", () => go(at - 1));
    next.addEventListener("click", () => {
      if (at < steps.length - 1) go(at + 1);
      else if (following) show(following.id, true);
      else go(0);
    });

    return { id: part.id, go, place, started: false };
  });

  function show(id, fromButton) {
    for (const part of parts) part.hidden = part.id !== id;
    for (const tab of tabs) tab.setAttribute("aria-current", String(tab.dataset.tourTab === id));
    const tour = tours.find((t) => t.id === id);
    if (!tour.started) {
      tour.started = true;
      tour.go(0);
    } else {
      tour.place();
    }
    if (location.hash !== `#${id}`) history.replaceState(null, "", `#${id}`);
    if (fromButton) document.getElementById(id)?.scrollIntoView({ block: "start" });
  }

  for (const tab of tabs) {
    tab.addEventListener("click", (e) => {
      e.preventDefault();
      show(tab.dataset.tourTab);
    });
  }

  let frameRequest = 0;
  const replace = () => {
    cancelAnimationFrame(frameRequest);
    frameRequest = requestAnimationFrame(() => tours.forEach((t) => t.place()));
  };
  addEventListener("resize", replace);
  document.fonts?.ready.then(replace);

  const first = parts.find((p) => `#${p.id}` === location.hash) || parts[0];
  show(first.id);
})();
