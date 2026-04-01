# Wrangler

Wrangler is a Dockerized media-ingest app for macOS and Windows hosts. A small host-side helper detects mounted SD cards, the web app lets an operator create a project and select source files, and a background worker copies the selection into the project folder and then out to two destinations with checksum verification.

## AI Disclaimer

This project was developed with AI assistance and primarily tested on macOS. All code, configuration, and operational behavior should be reviewed and tested by a human before production use, especially around file operations, data integrity, path handling, and platform-specific host integration. Windows helper support has been added, but Windows-specific workflows and features have not yet been fully verified end-to-end.

## Services

- `apps/api`: Express API backed by SQLite for projects, jobs, events, and checksum records.
- `apps/web`: React web UI for project creation, source selection, and job monitoring.
- `apps/host-helper`: macOS-only helper that scans `/Volumes` and enriches mounted volumes with `diskutil` metadata.
- `apps/windows-host-helper`: native Windows helper that exposes removable drive metadata over the same `/volumes` HTTP contract.
- `packages/shared`: shared schemas and types.

## Storage Flow

1. Source volume appears on the host under `/Volumes` on macOS or as a removable drive letter on Windows.
2. The host helper exposes mounted-volume metadata over HTTP.
3. The API creates a project under `PROJECTS_ROOT`.
4. The worker copies selected files from the source volume into the project folder.
5. The worker computes SHA-256 checksums for the project copy.
6. The worker mirrors the project folder into destination A and destination B.
7. The worker verifies both destinations against the project manifest and records the results in SQLite.

## Requirements

- `Node.js` 20+ recommended
- `npm` 10+ recommended
- `Docker Desktop`
- macOS helper: `diskutil` available on the host
- Windows helper: `.NET 8 SDK`

## Dependencies

- Runtime/workspace:
  - `express`
  - `react`
  - `vite`
  - `better-sqlite3`
  - `zod`
  - `sharp`
  - `ffmpeg` in the API container for video thumbnails
- Windows host helper:
  - `System.Management`
- Development/build:
  - `typescript`
  - `tsx`
  - `@types/*` packages used by the workspaces

## Installation

1. Clone the repository.
2. Create your environment file:

```bash
cp .env.example .env
```

3. Install JavaScript dependencies:

```bash
npm install
```

4. Review `.env` and adjust host-mounted roots, destination paths, and ports if needed.

## Local Setup

1. Start the helper that matches your host OS:

```bash
npm run dev -w @wrangler/host-helper
```

On Windows, run the native helper instead:

```bash
cd apps/windows-host-helper
dotnet run
```

2. Start the Docker services:

```bash
docker compose up --build
```

3. Open the web UI at `http://<mac-hostname-or-ip>:5173`.

The API is served on port `4001`, and the worker runs as a separate background container process.

## Notes

- SD-card detection happens outside the containers via a host-side helper.
- The API and worker mount `/Users` so you can choose Mac-local destination folders from the web UI.
- Source volumes are mounted read-only into the containers by default.
- The web app derives the API host from the current browser hostname so it can be opened from another machine on the LAN.
- The current implementation uses a SQLite database file at `DATABASE_PATH`.
# wrangler
