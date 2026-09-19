# Assistant harness qualification

Status: **Pi 0.85.1 is integrated; offline Electron acceptance passes all canonical MCP tools. Live-model quality and qualitative visual acceptance are not qualified.**

Reviewed September 16, 2026. The stock OpenCode candidate failed the zero-automatic-provider-retry requirement. Following the user's decision to qualify another harness, the real Pi SDK passed the replacement checks below. The production adapter now adds bounded lifecycle, canonical MCP policy, human approvals, private history, authenticated Studio events, and Inspector/image attachments. See `docs/assistant.md` for operation and `docs/assistant-acceptance.md` for release evidence. The OpenCode findings below are historical rejected-candidate evidence, not the active implementation.

## Candidate and provenance

- Evaluated runtime: `opencode-darwin-arm64@1.18.30`, paired with `@opencode-ai/sdk@1.18.30`.
- OpenCode source tag `v1.18.30`, commit `3104c1428ec91f809e5ab86631300de41eb6952e`; source and SDK license: MIT. Retain the upstream license if redistributed.
- Runtime executable SHA-256: `2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`.
- Runtime tarball integrity: `sha512-KO4FJGZpgmSz+NNQ6PizynT5qAzVfoZI5HJLpyD0tYNqePPu87g2/UgVmNW663Bock2r75koLZFjR5waZiFiqw==`.
- SDK tarball integrity: `sha512-uviJ+PZLc/D1szt33WGzzt/rqJ+IaNmRGBb+UcOXrcQANl8XXKJrp4CNQQ2UAnUJ3Ek+VqcamIwjtKHUW/OjOQ==`.
- Actual probe environment: macOS arm64, Node `v24.18.0`. The precompiled runtime runs independently of Node; its SDK client was exercised from Node. Other platforms are not qualified by this run.
- The initial `1.18.31` candidate was unavailable through the environment's package proxy (`ETARGET`, publication cutoff). The explicitly recorded `1.18.30` pair was used for qualification instead, not silently adopted as a production dependency.

The rejected OpenCode artifacts and upstream checkout are under ignored `.builder/assistant-qualification/`. That experiment did not change dependencies or install a global harness. The subsequent accepted Pi integration pins optional dependencies in the root `package.json` and lockfile; OpenCode is not a production dependency.

Official documentation and pinned source references:

```text
https://opencode.ai/docs/sdk
https://opencode.ai/docs/server
https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/processor.ts
https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/retry.ts
```

The locally checked-out tag also supplied `session/llm.ts`, `session/prompt.ts`, `config/config.ts`, `config/managed.ts`, `LICENSE`, and package types. Unversioned documentation alone is not qualification evidence.

## Minimal backend spike

`packages/assistant/src/opencode.ts` is **qualification-only**, not a production adapter. It cannot accept a real provider URL: only an explicit numeric loopback HTTP origin is accepted. It launches the reviewed executable without a shell, with a fresh private temporary home/config/data/cache/state/work directory, an allowlisted environment, a random HTTP Basic password, and loopback binding. The SDK's default launcher is deliberately not used because its implementation spreads the parent's environment.

The test configuration disables built-in tools, implicit title/summary/compaction agents, auto-compaction, snapshots, sharing, model downloads, default/external plugins, project configuration, and external skills. Only the local mock provider is configured. These settings describe the intended posture; they do **not** prove the full isolation gate. In particular, upstream macOS managed-preference loading still needs separate resolution: the inspected `config/managed.ts:43–65` reads system-managed plist paths independently of HOME/XDG configuration. No OS sandbox or process-tree/parent-loss guarantee is claimed for this probe.

`packages/assistant/src/opencode.test.ts` checks the candidate configuration, rejection of nonfixture URLs, and noninheritance of host credentials/configuration. These unit tests are not a substitute for the real-runtime test.

## Observed real-runtime results

Run `scripts/assistant-harness-spike.mjs` with the real pinned SDK and executable:

1. Authenticated headless startup succeeded. The temporary root was mode `0700`; an unauthenticated session request returned `401`.
2. No calls reached the mock provider during startup/session setup before the explicit prompt.
3. One explicit prompt generated exactly one mock provider request. The request advertised zero tools; the SDK delivered text deltas and the final expected response.
4. A new SDK client read the same session's assistant history. This proves client reconnect/readback, **not** reconstruction after backend restart.
5. A second explicit prompt received HTTP `429` with `Retry-After: 1`. The runtime submitted the request again approximately one second later, despite provider `options.maxRetries: 0`.
6. SDK session abort stopped further mock requests during the following 2.5-second observation. The child exited and its temporary data directory was removed.

The probe exited **2**, intentionally indicating a reproduced qualification blocker, not a passing harness. Exit **1** means the probe itself failed or produced inconclusive evidence. No exit status from this limited probe qualifies the complete harness.

The report is `.builder/assistant-qualification/result.json`. It records bounded event types/request metadata, binary hash, observed checks, and the blocker; it does not retain credentials, HTTP authorization, full prompts, source, or base64 image data. All three observed model requests went to the local fixture, with a dummy sentinel key. No real provider was configured or called. There is no claim of comprehensive outbound-network interception.

## Why the retry override is insufficient

In the pinned source, `session/llm.ts:323` sets the SDK-level `maxRetries` from `input.retries`, defaulting to zero. However, `session/processor.ts:674–688` separately wraps session processing in `Effect.retry(SessionRetry.policy(...))`. `session/retry.ts:31,183–205` implements its own five-retry bound and has no per-session zero-retry input in that policy signature. The public prompt types expose no corresponding retry override. The real mock-provider experiment demonstrates that a provider-level override does not stop this second retry layer.

Disabling the title agent avoids the separate title-generation call/retries (`session/prompt.ts:193–235`); that does not fix the session processing retry layer. Cancelling when a retry event arrives is not an acceptable substitute for pre-dispatch enforcement: it introduces a race rather than proving zero automatic paid retries.

## Reproduction

With the reviewed artifacts already extracted at the paths above:

```sh
pnpm exec tsx scripts/assistant-harness-spike.mjs
pnpm exec vitest run packages/assistant/src/opencode.test.ts
pnpm lint
pnpm typecheck
```

The first command intentionally exits 2 for the current candidate. It launches only the local fixture and the isolated candidate, then removes its temporary session files. It does not use Builder's MCP socket, touch generated apps, start Preview, or enable any real provider. Artifact acquisition/integrity review must happen separately; the script does not download or install a harness. Normal application startup never runs this script.

## Verification record

On September 16, 2026:

- The real-runtime probe reproduced the retry blocker twice, both times exiting **2**, with clean child exit and temporary-data removal. The second run observed 1,010 ms between the initial mock 429 request and the automatic retry.
- `pnpm lint`: **exit 0**.
- `pnpm typecheck`: **exit 0**, including all application/test TypeScript configurations.
- `pnpm test`: **exit 0**, **194 tests across 29 files**, including 11 qualification-configuration cases.
- `pnpm build`: **exit 0**. The existing Studio JavaScript chunk-size warning remains.
- No assistant browser/Electron scenario, screenshot/vision review, live-model trial, or complete assistant release/snapshot gate was run. Those are intentionally deferred because the first harness gate failed, not reported as passing.
- Existing tracked application files and dependency manifests are unchanged; all source changes are the standalone qualification helper/test, probe script, and this report. No commit or push was performed.

## Rejected OpenCode candidate: decision record

The following were **unverified for OpenCode**, not implicitly passed: complete canonical MCP tool/resource/prompt/PNG round-trips; every tool's execution and policy enforcement; hostile inherited configuration/plugin/managed-preference tests; pre-dispatch approvals and cancellation races; full credential/transcript persistence audits; parent-loss/process-tree cleanup; restart reconstruction; image acceptance by a vision model; and desktop/UI acceptance.

The user chose **qualify another external harness**. The earlier alternatives were:

- Qualify another external harness against the same requirements (no homemade agent loop).
- Separately authorize investigation of a maintained, pinned OpenCode fork that fixes retry and remaining isolation controls, then rerun the entire gate. A fork is a maintenance/build/distribution decision, not a silent adapter patch.
- Pause the integrated assistant and retain the existing canonical MCP/CLI workflow.

A retry-enforcing provider proxy would add another credential/transport/security boundary and is not part of the approved small adapter. No such proxy or OpenCode fork was implemented.

## Replacement candidate: Pi 0.85.1

The selected replacement is `@earendil-works/pi-coding-agent@0.85.1`, with its real `@earendil-works/pi-ai` and `pi-agent-core` 0.85.1 dependencies. This is the upstream `earendil-works/pi` package, not the older `@mariozechner/pi-coding-agent` package. License: MIT; declared Node requirement: `>=22.19.0`. Tested on macOS arm64 / Node `v24.18.0`. The official release is `v0.85.1` (`d981de1`); the installed package's bundled SDK documentation, public declarations, and implementation were inspected as well as the release page. No live provider credentials were supplied.

```text
https://github.com/earendil-works/pi/releases
```

Qualification installation is confined to ignored `.builder/pi-qualification/runtime`. It is not a global install or part of normal Builder startup. Package integrity recorded by the installation:

- coding-agent: `sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==`
- pi-ai: `sha512-+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==`
- pi-agent-core: `sha512-hIXIP3eAWueAYiAl8aMvWCvvZ8Q5gT3Dip5bE5uJyIGh4+YlWRjtMLI4BaeoXoSs93zndjue61u1B/vhefLnuA==`
- disposable installation lock SHA-256: `b491e0fe03e7948537fc7509ad0da8aa694f9edd311d1dc6a828fcccefe84df3`

### Explicit embedding posture

`scripts/pi-harness-spike.mjs` runs the real SDK in a forked Node process, with a new private working/home/config directory, allowlisted environment, empty inherited `execArgv`, and private Node IPC. Pi has no HTTP server in this posture, so there is no unauthenticated harness endpoint or renderer-held harness password. The only TCP listener is the fixture provider; canonical Builder access uses its existing private same-user MCP socket.

The SDK's defaults are **not safe for this integration**. The spike explicitly supplies:

- `noTools: 'all'` and an exact dynamically discovered custom-tool allowlist. Built-in read/bash/edit/write/network tools remain unavailable even when the fixture model attempts to call them.
- A caller-owned resource loader returning no extensions, skills, prompt templates, agent files, themes, or appended project instructions. It never instantiates `DefaultResourceLoader`. Hostile global/project settings, `AGENTS.md`, and a throwing extension were planted and demonstrably ignored.
- Caller-owned non-file credentials/models, `allowModelNetwork: false`, `refreshOnCreate: false`, in-memory session/settings managers, disabled analytics/install telemetry/compaction, agent retry disabled and provider retries explicitly zero.
- Sequential custom tools, a pre-dispatch allow/block hook, and a final `AbortSignal` check inside the forwarding boundary. The same signal goes to MCP. `beforeToolCall` is treated as allow/block, **not argument replacement**. Tool-start events are not authorization evidence.
- Original MCP schemas and full raw results retained in host-side tool details, with content blocks forwarded separately. `afterToolCall` preserves MCP `isError`; otherwise Pi's normal successful-return convention would mislabel a structured MCP error. Narrow protocol helpers forward resource/prompt operations instead of copying Builder handlers.

No handmade agent loop, default CLI launcher, file-backed harness session store, extra orchestration framework, paid retry proxy, or model-controlled credential endpoint was added.

### Real-runtime evidence

Run against the already-reviewed local artifacts and built canonical Builder server:

```sh
pnpm build
node scripts/pi-harness-spike.mjs
node scripts/pi-harness-spike.mjs --responses
node scripts/pi-harness-spike.mjs --responses --parent-loss
```

Each command must exit **0**; missing artifacts, timeout, schema divergence, unexpected dispatch, retry, credential leak, or assertion failure fails the probe. There are no package downloads or external model calls in the probe. Source scripts are retained; reports are ignored local evidence, not release artifacts.

Both OpenAI-compatible Chat Completions and Responses adapters passed the same deterministic tests. Each full run made 33 requests to the local fixture (including explicit prompts, tool continuations, injected errors, and cancellation); these are not paid requests. Results are in `.builder/pi-qualification/report.json` and `responses-report.json`. Parent-loss evidence is in `parent-loss-report.json`.

Observed checks:

1. No provider request at initialization; streamed text deltas after an explicit prompt. All 32 discovered Builder names and input schemas reached the provider unchanged. No native harness tools were advertised.
2. Both HTTP 429 and 500 generated exactly one request each, with no automatic retry during the observation interval. Responses requests set `store: false`.
3. Real `project_create`, inspection, import, and image reads executed through the canonical MCP socket against the same disposable Engine. No generated user app was opened or modified.
4. Resource lists/templates and prompt discovery matched the canonical server. Guide and `build-mobile-app` retrieval matched canonical results exactly. PNG tool results, PNG resource results, and explicit user images arrived at the provider adapter as image content/data URLs, not text containing base64 image data.
5. Structured MCP errors retained both `isError` and structured details. Pre-dispatch denial prevented a write. Fabricated shell/file/network tool calls never reached Builder. Cancel while dispatch was held prevented both queued calls; aborting an open model stream produced no subsequent provider request.
6. Reconstructed in-memory messages in a new SDK session without submitting another prompt; only the next explicit prompt caused a request. This is the reconstruction seam, not production history persistence/restart acceptance.
7. Hostile configuration text did not enter prompts. The credential sentinel appeared only in the local provider Authorization header, not request bodies, session messages, retained project/config/history files, or captured worker output. No harness auth or session files were created.
8. Normal shutdown closed the harness and MCP connection. A separate parent-disconnect test during an open provider stream proved worker exit, MCP socket removal, and provider-listener closure. The wrapper bounds startup to 20 seconds and the whole qualification run to 90 seconds and deletes its temporary root.

The fixture's fetch monitor observed **zero nonfixture fetch attempts**. This is not a claim of a general OS/network sandbox or exhaustive native-module instrumentation. The production boundary must retain the explicit resource/tool suppression, private process/IPC ownership, and no inherited credentials/configuration.

### Gate decision and production integration

**The replacement passes the bounded harness-compatibility gate.** The spike remains qualification-only. Production uses `packages/assistant/src/pi.ts` and `pi-worker.ts`, not the spike, and adds project/run binding, one-use reviewed approvals, durable bounded/redacted history, and payload/turn quotas. Pi and pi-ai 0.85.1 plus typebox 1.3.7 are optional root dependencies; there is no second harness framework or assistant package manifest.

`pnpm test:desktop` passed on September 16, 2026 with the real supervised Pi worker and deterministic local Responses provider: all 32 dynamically discovered canonical MCP tools executed, plus discovery/resource/prompt helpers, PNG transport, exact human-review cards, Inspector attachment, two-phone continuity, shared external MCP/CLI state, reconnect, hidden-window continuity, backend restart/history recovery, cleared credentials, and owned cleanup. There were 90 local fixture requests and no external model/image-provider calls. The fixture uses only its public dummy credential; real keys are rejected in fixture mode. Normal application startup cannot configure the fixture through Studio or MCP.

Unit and API regressions additionally cover forged/replayed/expired approvals, cross-project and stale-view inputs, hostile configuration, strict endpoint authentication, event recovery, quotas, symlink/hardlink rejection, credential isolation, cancellation/late dispatch, and zero retries on HTTP 429/500. `docs/assistant-acceptance.md` records final aggregate release results separately.

The deterministic provider received actual PNG bytes through the real adapter; it did not reason about their contents. **visual review blocked**: screenshot inspection in the current harness exposes PNG bytes rather than rendered images. Live-model reasoning/image understanding, native behavior, and native save-dialog interaction remain separate acceptance gates. No live-provider trial, signing, publication, commit, or push was performed.
