// Local test sites for assisted password change (tests/password-change.spec.ts,
// DESIGN.md "Assisted password change"). The fixture server hands these
// requests here. Each test site is a host the browsers in the tests resolve to
// the fixture server, and its first label says how it behaves:
//
// - cp-works: a standard change-password form (current, new, confirm) that
//   takes the new password and says so.
// - cp-refuses: the same form, which always refuses the new password, with an
//   error the standard way (role="alert", aria-invalid).
// - cp-captcha: the form with a CAPTCHA-like check the person must tick.
// - cp-code: the form, then a page asking for a code sent to a phone.
// - cp-unsure: a form that sends the change in the background and then just
//   says "Done.", which tells nothing either way.
// - cp-away: its change-password address goes to another site.
// - cp-rules: the form's new-password field has passwordrules, minlength, and
//   maxlength of its own.
// - www.airfrance.com: the standard form, under a name with published rules.
//
// Every site keeps the account's password in memory. Tests set it and read it
// back, with what was sent, at /cp/state?site=<host> on the fixture server.
// Our own markup, as small as each pattern needs: no real site's code.

const sites = new Map();

function site(host) {
  if (!sites.has(host)) {
    sites.set(host, { password: "", pending: null, posts: [] });
  }
  return sites.get(host);
}

function scenario(host) {
  if (host === "www.airfrance.com") return "works";
  const first = host.split(".")[0];
  return first.startsWith("cp-") ? first.slice(3) : null;
}

const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escape(title)}</title>
<style>body { font: 16px system-ui, sans-serif; margin: 40px; } label, input, button { display: block; margin: 6px 0; }</style>
</head>
<body>
${body}
</body>
</html>`;
}

function form(kind, error = null) {
  const rules =
    kind === "rules"
      ? ` maxlength="16" minlength="12" passwordrules="required: lower; required: digit; allowed: [-_];"`
      : "";
  const invalid = error ? ` aria-invalid="true" aria-describedby="error"` : "";
  const captcha =
    kind === "captcha"
      ? `<div class="g-recaptcha" data-sitekey="test-site-key">
  <label><input type="checkbox" id="robot" name="robot" required> I'm not a robot</label>
</div>`
      : "";
  const script =
    kind === "unsure"
      ? `<script>
  document.getElementById("change").addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = new URLSearchParams(new FormData(event.target));
    await fetch("/cp/api", { method: "POST", body });
    const done = document.createElement("p");
    done.textContent = "Done.";
    event.target.replaceWith(done);
  });
</script>`
      : "";
  return page(
    "Change your password",
    `<h1>Account settings</h1>
<form id="change" action="/cp/submit" method="post">
  ${error ? `<p role="alert" id="error">${escape(error)}</p>` : ""}
  <label for="current">Current password</label>
  <input type="password" id="current" name="current" autocomplete="current-password">
  <label for="new">New password</label>
  <input type="password" id="new" name="new" autocomplete="new-password"${rules}${invalid}>
  <label for="confirm">Confirm new password</label>
  <input type="password" id="confirm" name="confirm" autocomplete="new-password"${invalid}>
  ${captcha}
  <button type="submit">Change password</button>
</form>
${script}`,
  );
}

const changed = () =>
  page("Password changed", `<h1>Your password has been changed</h1>`);

const codePage = () =>
  page(
    "Check your phone",
    `<h1>One more step</h1>
<form id="verify" action="/cp/code" method="post">
  <label for="otp">Enter the code we sent to your phone</label>
  <input type="text" id="otp" name="code" autocomplete="one-time-code" inputmode="numeric">
  <button type="submit">Verify</button>
</form>`,
  );

function send(
  res,
  status,
  body,
  type = "text/html; charset=utf-8",
  headers = {},
) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

/** Handles a change-password test site's request. Answers whether it did. */
export async function handleChangePassword(req, res) {
  const url = new URL(req.url, "https://x");
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();

  // The tests' own door, on the fixture server's address.
  if (url.pathname === "/cp/state") {
    const name = url.searchParams.get("site") ?? "";
    if (req.method === "POST") {
      const { password } = JSON.parse((await readBody(req)) || "{}");
      sites.set(name, {
        password: String(password ?? ""),
        pending: null,
        posts: [],
      });
      return (send(res, 200, "{}", "application/json"), true);
    }
    req.resume();
    return (
      send(res, 200, JSON.stringify(site(name)), "application/json"),
      true
    );
  }

  // Another site's page, where cp-away's address lands: a form that must stay empty.
  const kind =
    host.endsWith(".elsewhere.test") && url.pathname === "/cp/form"
      ? "works"
      : scenario(host);
  if (kind == null) {
    return false;
  }
  const state = site(host);

  if (url.pathname === "/.well-known/change-password") {
    req.resume();
    const to =
      kind === "away" ? "https://login.elsewhere.test/cp/form" : "/cp/form";
    return (send(res, 302, "", "text/plain", { location: to }), true);
  }
  if (url.pathname === "/cp/form" && req.method === "GET") {
    req.resume();
    return (send(res, 200, form(kind)), true);
  }
  if (
    (url.pathname === "/cp/submit" || url.pathname === "/cp/api") &&
    req.method === "POST"
  ) {
    const body = new URLSearchParams(await readBody(req));
    const current = body.get("current") ?? "";
    const next = body.get("new") ?? "";
    const confirm = body.get("confirm") ?? "";
    let error = null;
    if (current !== state.password) error = "That isn't your current password.";
    else if (next === "" || next !== confirm)
      error = "The new passwords don't match.";
    else if (kind === "refuses")
      error = "That password isn't allowed here. Choose another one.";
    else if (kind === "captcha" && body.get("robot") !== "on")
      error = "Tick the box first.";
    state.posts.push({ at: Date.now(), path: url.pathname, ok: error == null });
    if (error != null) {
      return (
        send(res, url.pathname === "/cp/api" ? 400 : 200, form(kind, error)),
        true
      );
    }
    if (kind === "code") {
      state.pending = next;
      return (send(res, 200, codePage()), true);
    }
    state.password = next;
    return (
      send(res, 200, url.pathname === "/cp/api" ? "{}" : changed()),
      true
    );
  }
  if (url.pathname === "/cp/code" && req.method === "POST") {
    const body = new URLSearchParams(await readBody(req));
    if (body.get("code") !== "123456" || state.pending == null) {
      return (send(res, 200, codePage()), true);
    }
    state.password = state.pending;
    state.pending = null;
    state.posts.push({ at: Date.now(), path: url.pathname, ok: true });
    return (send(res, 200, changed()), true);
  }
  return false;
}
