# ichilov-mcp

**Read your own records from beWell, the patient portal of Tel Aviv Sourasky Medical Center (Ichilov, איכילוב), from an AI assistant over MCP: lab results, imaging reports and visit summaries as PDFs, and upcoming appointments.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Unofficial. Not affiliated with the hospital. It uses the same API as the beWell website, which can change without notice.

Everything runs on your machine. You sign in on a page this server serves, the session is saved only on your computer, and this project has no hosted backend and collects nothing. Whatever your AI client requests is passed to that client and handled under its provider's privacy terms.

## Terms of use

- **Own records only.**
- **Read-only.** No bookings, cancellations or changes at the hospital.
- **The session file is secret.** It holds beWell's session cookies, is saved with mode `0600` under `~/.config/ichilov-mcp/`, and must never be committed or pasted.

## Install

```sh
git clone https://github.com/tadnir/ichilov-mcp.git
cd ichilov-mcp
npm install
npx playwright install chromium
npm test
```

## Use it from an MCP client

```json
{
  "mcpServers": {
    "ichilov": {
      "command": "npx",
      "args": ["tsx", "src/main.ts"],
      "cwd": "/absolute/path/to/ichilov-mcp"
    }
  }
}
```

For Claude Desktop, use absolute paths: `"command": "/absolute/path/to/node"` with `"args": ["/absolute/path/to/ichilov-mcp/node_modules/.bin/tsx", "/absolute/path/to/ichilov-mcp/src/main.ts"]`.

### Signing in

1. Ask your assistant something, for example "what were my last blood test results at Ichilov?".
2. While nobody is signed in, the tools answer with a link to a sign-in page this server serves on `http://localhost:8767/`. `ichilov_login` returns the same link.
3. Open it, enter your ID number (or passport) and the mobile number the hospital has on file, and pick how long to stay signed in (1 hour to 30 days). The hospital sends a one-time code by SMS, or by a voice call to a landline; enter it on the page.
4. Ask again.

Your ID, phone number and the code are only ever typed on that page and sent to the hospital. The assistant only ever sees the link.

beWell protects its sign-in with an invisible reCAPTCHA that only its own page can run, so the server does each step inside a Chromium browser open on the hospital's sign-in page. When reCAPTCHA wants a picture puzzle, the sign-in page shows it, and you solve it there by clicking the picture; nothing is solved automatically. The browser keeps its profile (Google's cookies included) in `ICHILOV_CONFIG_DIR/browser`, so reCAPTCHA asks fewer puzzles after the first sign-in, and the longer the session length you pick, the less often you sign in at all.

beWell has no refresh token: its session ends after about 20 minutes without activity. While the MCP server runs it checks in with beWell every 5 minutes, saves the session's cookies, and signs out at the end of the length you picked. A restart picks the saved session back up if it hasn't timed out in between.

### Tools

| Tool | What it reads |
| --- | --- |
| `list_documents` | Lab results, imaging reports, visit and hospitalization summaries, newest first; filter by kind, date or text |
| `get_document_pdf` | One of those documents as a PDF (lab values are only in the PDFs) |
| `list_appointments` | Upcoming appointments |
| `ichilov_login`, `ichilov_session_status`, `ichilov_logout` | The sign-in link, whether a session is live and until when, and sign-out |

beWell has no prescriptions.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `ICHILOV_CONFIG_DIR` | `~/.config/ichilov-mcp` | Where the session and the sign-in browser's profile are saved |
| `ICHILOV_LOGIN_HOST` | `127.0.0.1` | Address the sign-in page listens on |
| `ICHILOV_LOGIN_PORT` | `8767` | Its port; a free one is used if another copy holds it |
| `ICHILOV_LOGIN_URL` | `http://localhost:<port>/` | The link handed out, when the page sits behind a reverse proxy. When set, the page starts with the server. |
| `ICHILOV_HEADLESS` | `true` | `false` also shows the sign-in browser's window |
| `ICHILOV_CHROMIUM_PATH` | Playwright's Chromium | Another Chromium to sign in with |

## Hosting one long-lived copy

To share one session between several clients, run a single copy on an always-on machine at home and put a stdio-to-HTTP MCP proxy in front of it, such as [TBXark/mcp-proxy](https://github.com/TBXark/mcp-proxy), with a bearer token per client. Keep it on your own network or a private VPN, never on the internet. Put the sign-in page behind your own authentication and set `ICHILOV_LOGIN_URL` to its address (and `ICHILOV_LOGIN_HOST=0.0.0.0` inside a container). Its links and forms are relative, so it can sit at the root of a host or under a path whose prefix the reverse proxy strips (`ICHILOV_LOGIN_URL=https://mcp.example.com/ichilov/login/`, with the trailing slash).

Every token holder reads the records of whoever signed in on the page; the proxy's tokens and the beWell session are unrelated. For a second person, run a second copy with its own `ICHILOV_CONFIG_DIR`, tokens and sign-in page.

The `Dockerfile` builds an image of the stdio server with Chromium, published as `ghcr.io/tadnir/ichilov-mcp` from master, with the session in `/data` and the page on port 8767. Run it with `docker run -i`, or use it as a base for an image that adds your MCP proxy.

The sign-in page answers only to `localhost`, `127.0.0.1` and the host in `ICHILOV_LOGIN_URL`, and each form carries a per-process token. Anyone who can open the page can sign in or out, so keep it on loopback or behind your own authentication.

## License

[MIT](LICENSE)
