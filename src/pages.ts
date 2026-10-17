import type { KeeperStatus } from "./keeper.js";
import { LENGTH_ENDED } from "./keeper.js";

export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' blob:; script-src 'self'; connect-src 'self'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}
main{max-width:30rem;width:100%}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:.25rem 0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;margin:0 0 1rem}
dt{opacity:.7}
dd{margin:0}
form{display:inline-block;margin:0 .5rem .5rem 0}
label{display:block;margin:0 0 1rem;font-weight:600}
label.inline{font-weight:400;margin-top:-.5rem}
input[type=text]{display:block;width:100%;box-sizing:border-box;margin-top:.25rem;padding:.6rem;font:inherit;border:1px solid #8888;border-radius:.4rem}
select{font:inherit;padding:.4rem;margin-left:.5rem;border-radius:.4rem}
button{padding:.6rem 1.1rem;font:inherit;border:0;border-radius:.4rem;background:#0b6e4f;color:#fff;cursor:pointer}
button.secondary{background:#8884;color:inherit}
.note{font-size:.85rem;opacity:.7}
.err{color:#b00020}
.puzzle{position:relative;display:inline-block;max-width:100%;line-height:0;margin:0 0 1rem}
.puzzle img,input.puzzle{display:block;max-width:100%;height:auto;border:1px solid #8884;border-radius:.4rem;cursor:pointer;touch-action:manipulation}
.puzzle .dot{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:#0b6e4fcc;pointer-events:none;transition:opacity .6s}`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function when(iso?: string): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem" });
}

function errorLine(error?: string): string {
  return error ? `<p class="err">${escapeHtml(error)}</p>` : "";
}

/** How long a sign-in lasts, as offered at sign-in: value => [label, ms]. */
export const SESSION_LENGTHS: Record<string, [string, number]> = {
  "1h": ["1 hour", 3_600_000],
  "6h": ["6 hours", 6 * 3_600_000],
  "12h": ["12 hours", 12 * 3_600_000],
  "1d": ["1 day", 24 * 3_600_000],
  "2d": ["2 days", 48 * 3_600_000],
  "1w": ["1 week", 7 * 24 * 3_600_000],
  "30d": ["30 days", 30 * 24 * 3_600_000],
};
export const DEFAULT_SESSION_LENGTH = "1d";

function idForm(csrf: string, label: string, secondary: boolean): string {
  const options = Object.entries(SESSION_LENGTHS)
    .map(([value, [text]]) => `<option value="${value}"${value === DEFAULT_SESSION_LENGTH ? " selected" : ""}>${text}</option>`)
    .join("");
  return `<form method="post" action="start"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>
<label>ID number (תעודת זהות) or passport<input type="text" name="id" autocomplete="off" pattern="[0-9A-Za-z]{1,20}" required/></label>
<label class="inline"><input type="checkbox" name="passport" value="1"/> It's a passport number</label>
<label>Mobile number on file at the hospital<input type="text" name="phone" inputmode="tel" autocomplete="off" pattern="[0-9+ \\-]{9,16}" required/></label>
<label>Stay signed in for<select name="length">${options}</select></label>
<button type="submit"${secondary ? ' class="secondary"' : ""}>${escapeHtml(label)}</button></form>`;
}

export function idPage(status: KeeperStatus, csrf: string, error?: string): string {
  let why = "Nobody is signed in to beWell yet.";
  if (status.state === "expired") {
    why =
      status.lastError === LENGTH_ENDED
        ? `The session length you chose ran out at ${when(status.endedAt)}.`
        : `beWell ended the session at ${when(status.endedAt)}.`;
  }
  return layout(
    "Sign in to beWell",
    `<h1>Sign in to Ichilov beWell</h1>
<p>${escapeHtml(why)} The hospital sends a one-time code by SMS (or a voice call) to the mobile number it has on file.</p>
${errorLine(error)}
${idForm(csrf, "Send code", false)}
<p class="note">Your ID, phone number and the code go only to the hospital, through its own sign-in page. This server keeps the resulting session on this machine.</p>`,
  );
}

export function codePage(csrf: string, error?: string): string {
  return layout(
    "Enter the beWell code",
    `<h1>Enter the code</h1>
<p>The hospital sent a one-time code to your mobile.</p>
${errorLine(error)}
<form method="post" action="code"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>
<label>Code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" required/></label>
<button type="submit">Sign in</button></form>
<form method="post" action="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/><button type="submit" class="secondary">Start over</button></form>`,
  );
}

export function statusPage(status: KeeperStatus, csrf: string): string {
  return layout(
    "Ichilov MCP",
    `<h1>Ichilov MCP</h1>
<p>Signed in to beWell. beWell ends a session after about 20 idle minutes, so while the MCP server runs it checks in every few minutes, and your assistant can read your records until the session ends.</p>
<dl>
<dt>Signed in</dt><dd>${escapeHtml(when(status.signedInAt))}</dd>
<dt>Ends</dt><dd>${escapeHtml(status.endsAt ? when(status.endsAt) : "when beWell ends it")}</dd>
<dt>Last checked</dt><dd>${escapeHtml(when(status.lastCheckedAt))}</dd>
</dl>
${status.lastError ? `<p class="err">Last check error: ${escapeHtml(status.lastError)}</p>` : ""}
<p class="note">To change how long the session lasts, sign in again. The current session stays until the new one succeeds.</p>
${idForm(csrf, "Sign in again", true)}
<form method="post" action="sign-out"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/><button type="submit" class="secondary">Sign out</button></form>`,
  );
}

/** While the hospital's page works in the background; reloads itself. */
export function workingPage(csrf: string, what: string): string {
  return layout(
    "Signing in to beWell",
    `<meta http-equiv="refresh" content="2"/><h1>${escapeHtml(what)}</h1>
<p>This page reloads by itself.</p>
<form method="post" action="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/><button type="submit" class="secondary">Start over</button></form>`,
  );
}

/**
 * reCAPTCHA's picture puzzle, from the hospital's page: a click on the picture
 * is a click there. puzzle.js keeps the picture live and sends each click
 * without reloading the page; without scripts, the picture is a form button.
 */
export function puzzlePage(csrf: string): string {
  return layout(
    "Solve the puzzle",
    `<h1>Solve reCAPTCHA's puzzle</h1>
<p>The hospital's sign-in page asks for this. Tap the picture as you would there, including its button (verify or skip). It updates by itself as you go.</p>
<form method="post" action="puzzle" id="puzzle-form" data-csrf="${escapeHtml(csrf)}"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>
<div class="puzzle"><input type="image" name="p" src="puzzle.png?t=${Date.now()}" alt="reCAPTCHA puzzle" class="puzzle" id="puzzle"/></div></form>
<form method="post" action="cancel"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/><button type="submit" class="secondary">Start over</button></form>
<script src="puzzle.js"></script>`,
  );
}

/**
 * Served as puzzle.js. Swaps the picture for a fresh one about three times a
 * second, sends each tap at the picture's own scale (the page may show it
 * smaller), and reloads once the puzzle is gone for good, which moves on to
 * the next step.
 */
export const PUZZLE_SCRIPT = `(function () {
  var form = document.getElementById("puzzle-form");
  var input = document.getElementById("puzzle");
  if (!form || !input || !window.fetch) return;
  var csrf = form.getAttribute("data-csrf");
  var img = new Image();
  img.alt = input.alt;
  img.src = input.src;
  var box = input.parentNode;
  box.replaceChild(img, input);
  var missing = 0, busy = false;
  function refresh() {
    if (busy) return;
    busy = true;
    fetch("puzzle.png?t=" + Date.now(), { cache: "no-store" }).then(function (res) {
      if (res.status === 404) {
        // Gone between two challenges, or solved: reload once it stays gone.
        if (++missing >= 4) location.reload();
        return;
      }
      missing = 0;
      return res.blob().then(function (blob) {
        var next = URL.createObjectURL(blob), old = img.src;
        img.onload = function () { if (old.indexOf("blob:") === 0) URL.revokeObjectURL(old); };
        img.src = next;
      });
    }).catch(function () {}).then(function () { busy = false; });
  }
  img.addEventListener("click", function (e) {
    var rect = img.getBoundingClientRect();
    var scale = img.naturalWidth ? img.naturalWidth / rect.width : 1;
    var x = Math.round((e.clientX - rect.left) * scale), y = Math.round((e.clientY - rect.top) * scale);
    var dot = document.createElement("span");
    dot.className = "dot";
    dot.style.left = (e.clientX - rect.left) + "px";
    dot.style.top = (e.clientY - rect.top) + "px";
    box.appendChild(dot);
    setTimeout(function () { dot.style.opacity = "0"; }, 300);
    setTimeout(function () { dot.remove(); }, 1000);
    var body = new URLSearchParams({ csrf: csrf, "p.x": String(x), "p.y": String(y) });
    fetch("puzzle", { method: "POST", body: body, headers: { "x-puzzle-live": "1" } })
      .then(function () { setTimeout(refresh, 250); }, function () {});
  });
  setInterval(refresh, 350);
})();
`;

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
