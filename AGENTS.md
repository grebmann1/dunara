# Working in Dunara OSS

This repository owns the shared builder, Studio, SDK, catalogue and execution adapters. Fix shared behavior here. Do not copy private cloud server/shell code or website source into this repository.

Use Node 24 and pnpm 11.13.1. Read docs/package-guide.md before changing public APIs. Preserve mobile-builder, SDK API 1, persisted paths/identities and generated-app environment names. Test only disposable workspaces; never reuse a user's profile or expose launch tickets in logs/traces.

Run the checks appropriate to your change. Changes to package boundaries must pass pnpm build:packages and pnpm test:packages from a clean checkout. Studio changes need screenshot inspection at 375×812, 430×932 and desktop as well as behavior checks. Use the visual-review skill when changing layouts or flows.

Release the coordinated package set after candidate qualification. Website/cloud upgrades happen through exact dependency updates in their own repositories. Public CI needs no private repository token or cloud credentials. Keep deployment and package publication separate from validation.
