# Project Notes for agents

Use plugin_list to discover source-summary and recipe:notes. The former reads scoped files; the latter prepares a human review. No operation accepts credentials.

This package implements the public @mobile-builder/plugin-sdk API. TypeScript authors can import definePlugin, definePluginApp, defineRecipe and testPlugin from its documented exports. Bundle imports before packaging a plugin for installation.
