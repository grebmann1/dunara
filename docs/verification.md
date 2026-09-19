# Qualification scope

The September 19, 2026 repository split preserved the local product and introduced five installed package boundaries. The OSS migration checkout passed typechecking, lint, 441 unit/integration tests, the external packed consumer (Node runtime/resources, API authentication, MCP, browser declarations/CSS), and the external SDK plugin smoke.

Real macOS Electron checks passed encrypted backend settings/restart, two-process Keychain restoration, and the complete offline Assistant/MCP workflow: 65 tools discovered, 43 local tools exercised, approvals, launch-kit download, phone-sized layouts, reconnect/restart and owned shutdown. The release smoke passed built assets, exact template pins, independent previews, restart persistence and confirmed deletion. These runs used disposable data and fixture providers.

The Check workflow runs from a fresh Linux checkout, including browser integration, package consumer checks and archive receipts. Its live result is the authoritative CI status for a commit. Do not infer a successful CI run from this document. Desktop checks remain macOS-specific.

Responsive website and hosted-shell qualification belongs to their independent repositories. Studio, website and cloud phone/settings/plugin captures were actually inspected at 375×812, 430×932 and desktop during migration. They are web renderings, not physical-device captures or a new human aesthetic approval.

No live model/image request, Supabase deployment, email delivery, paid sandbox session, native signing or physical-phone qualification was performed for this split. Earlier private experiment logs and screenshots remain in the migration archive; they are not shipped as public operational data. Generated apps need their own device and release checks.
