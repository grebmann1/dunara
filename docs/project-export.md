# Download your project

Select an app in local Studio, then choose **Download project** below the project picker. Choose **Download ZIP** to save `<app-slug>.zip`. The desktop app uses its normal Save dialog; browsers use their download controls. Preview and the Assistant do not need to be running, and exporting does not execute or modify the app.

The ZIP contains a top-level folder named after the app's slug. It includes source and components, binary assets, fonts, app/build configuration, dependency files, backend functions and migrations, documentation, licenses, and supported project dotfiles such as `.gitignore` and `.editorconfig`. Script executable permissions are retained. Public `backend/connection.json` is included when present.

The added `DUNARA-EXPORT.md` explains how to install dependencies and run the project. If that name already exists, the guide gets a numbered suffix and the original document is preserved. The guide lists every omitted file or directory. For the curated starter, the npm lockfile keeps its exact versions and integrity hashes while registry tarballs are normalized to the public npm registry. Custom or incomplete lockfiles are preserved as written.

## Run outside Dunara

Unzip the archive and open its app folder in an editor. With Node 24 installed:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run web
# Or use a compatible Expo Go app:
npm run start
```

Use the app's own README and `package.json` scripts for custom projects. Recreate private environment variables or signing configuration locally. A backend connection supplied only by Dunara's runtime needs its public URL/key configured in the downloaded app; the ZIP does not inject credentials from Dunara's home. A downloaded source project is independent of Dunara, but this does not sign an app, deploy a backend or publish to a store.

## What stays out

- Installed dependencies and generated output: `node_modules`, build/export/coverage folders, native caches, compiled app packages and logs.
- Git history, Dunara metadata/history, temporary and other hidden local state. The export is an app source handoff, not a backup of the Studio profile or Assistant checkpoints.
- `.env` files (including examples), registry auth files, known credential/secret files, signing keys and local machine configuration.

These are filename/directory exclusions, not a content scan for arbitrary secrets written into code. The guide includes the exact omission list so missing custom setup can be identified. Source links and hardlinks are refused with an actionable error; copy their intended contents into ordinary files before retrying. Unsupported or colliding portable paths are also refused rather than silently omitted.

The current bounds are 4,000 files, 32 MiB per file, 128 MiB total, 24 directory levels, and 10,000 visited paths. Limit failures produce no partial archive. One download is prepared at a time. Source is read under the project mutation lock and checked again for external changes before packaging. If edits interrupt the snapshot, retry after they finish. Switching projects or closing the download dialog cancels/discards a pending download.

The local authenticated endpoint is `GET /api/projects/:projectId/download`; it returns `application/zip` with an attachment filename and `Cache-Control: no-store`. It accepts a registered project ID, not a filesystem path. Hosted export support and reviewed ZIP/Git import are separate follow-ups.
