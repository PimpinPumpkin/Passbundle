// Light or dark: the site follows the device until the visitor presses the
// header's button, and then remembers their pick in this browser
// (localStorage, never sent anywhere). Pressing it back to what the device
// uses forgets the pick, so the site follows the device again.
//
// It runs inline at the top of <head>, before anything is drawn, so a page
// never flashes the wrong theme, and it costs no request. The CSP allows
// exactly this script by its hash, which build.mjs adds to dist/_headers.
// What it sets:
//   <html data-theme="light|dark">  only while the visitor's pick overrides
//                                   the device (styles.css: build.mjs scopes
//                                   every dark-mode rule by it)
//   <html data-mode="light|dark">   the theme showing, for the button's icon
//   the screenshots' dark <source>, the theme-color meta tags, and the
//   button's aria-pressed and hidden (it stays hidden without scripts).
// Pressing the button spreads the new theme out from it (a view
// transition; styles.css "Motion"), unless the device asks for less motion.
export const THEME_SCRIPT = `(() => {
  const root = document.documentElement;
  const device = matchMedia("(prefers-color-scheme: dark)");
  let pick = null;
  try {
    pick = localStorage.getItem("theme");
  } catch {}
  if (pick !== "light" && pick !== "dark") pick = null;
  const apply = () => {
    const mode = pick || (device.matches ? "dark" : "light");
    if (pick) root.dataset.theme = pick;
    else delete root.dataset.theme;
    root.dataset.mode = mode;
    for (const s of document.querySelectorAll("picture.shot source")) {
      s.media = pick ? (pick === "dark" ? "all" : "not all") : "(prefers-color-scheme: dark)";
    }
    for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
      m.content = mode === "dark" ? "#0B0D0E" : "#FAFAF8";
    }
    for (const b of document.querySelectorAll("[data-theme-toggle]")) {
      b.hidden = false;
      b.setAttribute("aria-pressed", String(mode === "dark"));
    }
  };
  apply();
  device.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", apply);
  document.addEventListener("click", (e) => {
    const button = e.target.closest("[data-theme-toggle]");
    if (!button) return;
    const change = () => {
      pick = root.dataset.mode === "dark" ? "light" : "dark";
      if (pick === (device.matches ? "dark" : "light")) pick = null;
      try {
        if (pick) localStorage.setItem("theme", pick);
        else localStorage.removeItem("theme");
      } catch {}
      apply();
    };
    if (!document.startViewTransition || matchMedia("(prefers-reduced-motion: reduce)").matches) return change();
    const r = button.getBoundingClientRect();
    root.style.setProperty("--reveal-x", r.left + r.width / 2 + "px");
    root.style.setProperty("--reveal-y", r.top + r.height / 2 + "px");
    root.classList.add("theming");
    document.startViewTransition(change).finished.finally(() => root.classList.remove("theming"));
  });
})();`;

/** The header's button: a moon in light mode, a sun in dark mode. */
export const THEME_BUTTON = `<button type="button" class="theme-toggle" data-theme-toggle aria-pressed="false" hidden>
      <span class="sr-only">Dark mode</span>
      <svg class="moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"/></svg>
      <svg class="sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M12 2.5v2 M12 19.5v2 M4.6 4.6l1.4 1.4 M18 18l1.4 1.4 M2.5 12h2 M19.5 12h2 M4.6 19.4 6 18 M18 6l1.4-1.4"/></svg>
    </button>`;

/**
 * Dark mode follows the device unless the visitor picked one. Every
 * `@media (prefers-color-scheme: dark) { ... }` block in styles.css becomes
 * the same rules scoped to :root:not([data-theme="light"]) inside the media
 * query, plus a copy scoped to :root[data-theme="dark"] outside it. So the
 * stylesheet is written once, for the device, and the button works on all of it.
 */
export function themeable(css) {
  const open = "@media (prefers-color-scheme: dark) {";
  let out = "";
  let from = 0;
  for (let at = css.indexOf(open); at !== -1; at = css.indexOf(open, from)) {
    let depth = 1;
    let end = at + open.length;
    while (depth > 0) {
      if (end >= css.length) throw new Error("styles.css: a dark-mode block isn't closed");
      if (css[end] === "{") depth++;
      else if (css[end] === "}") depth--;
      end++;
    }
    const rules = css.slice(at + open.length, end - 1).replace(/\/\*[\s\S]*?\*\//g, "");
    if (rules.includes("@")) throw new Error("styles.css: a dark-mode block has an at-rule inside it");
    out += css.slice(from, at);
    out += `${open}${scope(rules, ':root:not([data-theme="light"])')}}\n${scope(rules, ':root[data-theme="dark"]')}`;
    from = end;
  }
  return out + css.slice(from);
}

function scope(rules, prefix) {
  return rules.replace(/(^|[{}])(\s*)([^{}]+?)(\s*)\{/g, (_, before, ws, selectors, ws2) => {
    if (before === "{") throw new Error("styles.css: nested rules in a dark-mode block");
    const scoped = selectors
      .split(",")
      .map((s) => s.trim())
      .map((s) => (s.startsWith(":root") ? prefix + s.slice(5) : s.startsWith("html") ? prefix + s.slice(4) : `${prefix} ${s}`))
      .join(",\n");
    return `${before}${ws}${scoped}${ws2}{`;
  });
}
