# macOS desktop prototype

Electron hosts the existing Studio in a sandboxed desktop window. It supervises one separate Node backend that owns Projects, Engine, authenticated Studio, Preview processes and a local MCP socket. Browser/headless CLI modes remain available; the desktop is not a packaged or distributed application.

## Launch

Use Node 24+ and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm desktop
```

The pinned Electron dependency downloads its binary during installation. If install scripts were previously disabled, run `pnpm rebuild electron`. The prototype runs only on macOS. No signing, installer, application bundle, auto-update service or publication is included.

Default generated-app workspace, Dunara registry and Chromium profile locations are separate directories under `.builder/desktop/`. Explicit `--workspace`, `--home` and `--user-data` overrides are supported. Do not point it at directories already owned by a running CLI/Studio. Existing MCP configuration is not changed automatically.

Execution is off by default. After reviewing the generated code and dependencies:

```sh
pnpm desktop --trust-execution
```

This authorizes local dependency installation and execution with your user permissions. **The renderer sandbox is not a sandbox for generated code or the backend.** Managed Preview still enforces its curated manifest/lockfile. The desktop does not enable LAN exposure.

## Connect an agent to the same backend

With desktop running, use **Studio → Copy MCP socket path**. Configure a stdio MCP connection whose command is Node and whose arguments are:

```text
/absolute/path/to/mobile-app-builder/dist/packages/cli/src/index.js
--desktop-connect
/the/socket/path/copied/from/the/Studio/menu
```

Use the actual copied path, not the placeholder above. Do not add `--workspace`, `--home`, `--studio`, `--studio-only`, `--trust-execution` or `--lan` to this connection. The bridge creates no Engine; its 51 tools share the desktop's projects, previews, captures, assets, Launch Kits and Studio workspace/view state. JSON CLI commands use the same socket; see [Shared controls and project memory](shared-control.md). Disconnecting an agent does not stop desktop. The private current-user Unix socket accepts at most four clients. Its path changes on backend restart; copy it again and reload the agent connection. Other processes running as your user are within this local trust boundary.

## Lifecycle

- Closing the window hides it, retaining the backend and Preview. **Studio → Show Studio** restores it.
- **Reconnect Studio…** asks for confirmation, discards unsaved UI drafts and redeems a fresh one-use launch ticket against the same backend. Running previews remain alive.
- **Restart backend…** asks for confirmation, closes owned previews, disconnects MCP clients, forgets unsaved session credentials/transient captures, restores saved/startup keys, starts one replacement backend and reconnects Studio. Project files and immutable Launch Kits remain on disk. Pending paid work is never automatically retried; cancellation cannot guarantee a refund.
- Quit with **Cmd+Q**, the application menu or Ctrl+C in the launching terminal. Normal quit waits for owned backend/Preview cleanup. The backend also closes when the Electron parent disconnects. Force-killing or an OS crash cannot guarantee graceful child cleanup.
- Startup/backend/renderer failures show a bounded, nonsecret error dialog. Closed diagnostic pipes are ignored so a detached launch terminal cannot crash restart. Recovery is explicit through the Studio menu, not an automatic execution or provider retry loop.

## Security and data

The window has sandbox/context isolation/web security enabled, no preload bridge, no Node integration in Studio, workers or child frames, and no webviews. Permissions, popups and external navigation are denied. Main-frame navigation is limited to Studio; child-frame navigation is limited to the backend's managed Preview origins. Existing per-view Inspector source/origin/nonce checks remain in place. Generated web content does not receive Electron capabilities or the Studio bearer.

The same loopback Host/Origin checks, one-use bootstrap tickets, authenticated API/WebSocket transport and CSP used by browser Studio apply here. Session browser storage is in memory. Desktop launches with an allowlisted environment and blocks Node/Electron injection variables. `OPENAI_API_KEY`, `BUILDER_ASSISTANT_API_KEY`, `BUILDER_BACKEND_ENCRYPTION_KEY`, `BUILDER_ACCOUNT_SUPABASE_URL`, `BUILDER_ACCOUNT_PUBLISHABLE_KEY` and `BUILDER_ACCOUNT_ALLOW_LOCAL` are explicitly captured, validated and transferred privately to the backend; the Dunara `.env` (or `--builder-env-file`) is also supported. OpenAI Settings defaults to session-only entry, with optional **Remember on this computer** using encrypted owner-only Dunara-home files backed by OS protection or an explicit configured encryption key. Locked storage retains existing data; unavailable protection permits session-only use. Saved keys override startup keys and are restored on restart; session-only replacements are forgotten. All service settings are excluded from managed app environments; only the selected app binding supplies its public Supabase URL/key/environment. Supabase remembered connections use encrypted storage and are retained unchanged if the original encryption key is unavailable. An absolute `NODE_EXTRA_CA_CERTS` path is forwarded to Node/npm; Node options and TLS verification overrides remain excluded. See [backend setup](backend-setup.md). See `docs/credentials.md` for setup, source precedence, deletion and same-user risks. Provider requests retain the existing per-request consent rules. Nothing verifies credentials or spends money automatically.

Imports use the existing bounded asset pipeline. Downloads are accepted only from the owned Studio main frame with matching initiating origin and a Studio HTTP/blob URL. Normal use retains the native save dialog and overwrite confirmation; no arbitrary renderer-to-filesystem IPC exists. Desktop window captures and generated-app previews remain web rendering, not iOS screenshots or installed launcher proof.

## Verification

Run `pnpm build` before tests that exercise the compiled runtime, then:

```sh
pnpm release:check
pnpm release:smoke
pnpm test:desktop
```

`test:desktop` launches actual Electron against temporary workspace/home/profile directories without provider configuration. It exercises shared stdio MCP, renderer privileges, two exact-size phone routes, Inspector, asset import, targeted reload/capture, Launch Kit download/hash verification, reconnect/hide/restart persistence and cleanup. It answers confirmation dialogs and chooses a temporary download destination through test-only main-process automation; **human native-dialog interaction is not established by that test**. Desktop host and transport tests cover lifecycle, one-use tickets, private socket boundaries and client reconnection. `pnpm test:desktop:backend` is a focused real-Electron gate for backend/account configuration, environment-over-file precedence, encrypted restart persistence, renderer isolation and a simulated EPIPE followed by restart. It uses isolated local state and makes no provider calls.

The browser release gates do not include `test:desktop`; run it separately for desktop changes. Human visual/gesture approval, native file-picker/save-dialog interaction, packaging/signing/distribution, installed iOS behavior and paid provider quality remain separate gates. If captures cannot be delivered as visible images, report **visual review blocked** rather than claiming aesthetic inspection.

### Loading a newly built desktop

After rebuilding desktop main-process or startup configuration code, fully quit and relaunch Dunara to load a matched desktop/backend version. **Restart backend** replaces only the child runtime; it cannot reload code already held by the Electron main process. Preserve unsent drafts before reconnecting or relaunching.

The phone guide’s Expo Go installation link and the Backend page’s Supabase token/project links open in the system browser. Only their exact official destinations are allowed, without query strings or fragments; arbitrary app popups remain blocked.
