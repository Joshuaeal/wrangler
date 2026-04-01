# **Wrangler**

**Reliable media ingest. Built for real workflows.**

Wrangler is a Docker-based ingest system designed for production environments where data integrity matters.

Cards come in. Files get selected. Wrangler handles structured ingest, dual backups, and checksum verification automatically.

---

## **Why Wrangler Exists**

Ingest is one of the highest-risk parts of a shoot.

Manual copies fail. Drag-and-drop gets messy. Verifying footage is slow or skipped entirely.

Wrangler removes that risk.

* Every file is tracked
* Every copy is verified
* Every job is repeatable

---

## **Core Features**

* **Automatic media detection**
  Detects mounted cards via a host-side helper

* **Project-based ingest**
  Create structured project folders before copying begins

* **Manual or automatic ingest**
  Run ingest manually by creating a project, selecting your source, and pressing ingest, or enable automatic ingest to trigger as soon as new media is detected

* **Selective file ingest**
  Choose exactly what gets copied

* **Multi-destination backup**
  Automatically mirrors to multiple locations

* **Checksum verification**
  SHA-256 verification across all copies

* **Job tracking**
  Full visibility of ingest status and results

* **Headless operation**
  Runs independently of the UI, allowing ingest jobs to continue uninterrupted even if the browser is closed. Wrangler can run directly on the host machine or be operated from another device on the same network

---

## **How It Works**

1. Insert media
2. Wrangler detects the volume
3. Create a project in the web UI
4. Choose manual or automatic ingest
5. Select source, and optionally choose specific files (manual)
6. Wrangler copies to a project folder
7. Wrangler mirrors to destination A - and if desired, B and C
8. Wrangler verifies all copies

Simple on the surface. Solid underneath.

---

## **Architecture**

Wrangler is built as a set of small services:

* **API** (`apps/api`)
  Express + SQLite backend managing projects, jobs, and checksums

* **Web UI** (`apps/web`)
  React interface for ingest control and monitoring

* **Host Helper (macOS)** (`apps/host-helper`)
  Detects volumes via `/Volumes` and `diskutil`

* **Host Helper (Windows)** (`apps/windows-host-helper`)
  Native .NET helper exposing removable drives

* **Shared Package** (`packages/shared`)
  Shared types and schemas

---

## **Quick Start**

```bash
git clone https://github.com/Joshuaeal/wrangler
cd wrangler
cp .env.example .env
npm install
```

### Start host helper

macOS:

```bash
npm run dev -w @wrangler/host-helper
```

Windows:

```bash
cd apps/windows-host-helper
dotnet run
```

---

### Start system

```bash
docker compose up --build
```

---

### Open UI

```
http://<your-machine-ip>:5173
```

For external access through a reverse proxy or Cloudflare Tunnel, point the public hostname at the web service only. The web container proxies `/api/*` to the API internally, so the app works behind a single public origin without exposing port `4001`.

---

## **Requirements**

* Node.js 20+
* npm 10+
* Docker Desktop

Platform-specific:

* macOS: `diskutil`
* Windows: .NET 8 SDK

---

## **Important Notes**

* Source media is mounted read-only
* `/Users` is mounted into containers for destination selection
* SQLite database stored at `DATABASE_PATH`
* API runs on `4001`, UI on `5173`
* Designed for LAN access across multiple machines

---

## **AI Disclaimer**

Wrangler has been developed with AI assistance and primarily tested on macOS.

Before production use, review and validate:

* file operations
* data integrity
* path handling
* platform-specific behaviour

Windows support exists but is not yet fully validated end-to-end.

---

## **Where This Is Going (optional but strong)**

Wrangler is evolving toward a full ingest system for small-to-mid production teams.

Planned directions:

* Watch-folder automation
* Camera card presets
* Proxy generation
* Cloud sync workflows
* Multi-operator ingest

---

## **Positioning (keep or remove depending on audience)**

Wrangler is for crews who don’t want ingest to be a liability.

It’s built for:

* DITs
* videographers
* small production teams
* live and event environments

Plug in. Select. Ingest. Verified.

