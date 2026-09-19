# Authoring for Dunara

Use @mobile-builder/plugin-sdk/server, /app, /recipes and /testing. API version 1.

1. Scaffold: mobile-builder plugin new /absolute/plugin-directory.
2. Register actions with JSON input/output schemas and read/write effects. Project file access requires declared capabilities and a selected app.
3. Export a browser entry with apiVersion: 1 and panels. Each panel mounts in an owned element and returns cleanup.
4. Validate and pack with mobile-builder plugin validate <directory> and plugin pack <directory>.
5. Install using Plugins in a running Dunara profile, or use plugin dev <directory> for the reviewed development installation steps.
6. Test disable/restart/reinstall and error states. Do not import Dunara repository internals.

Write actions and recipes require human review in Plugins. Guides are context, not authorization. Never put credentials in actions, generated source or logs. Private credential fields belong in Plugins.
