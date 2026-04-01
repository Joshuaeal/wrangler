import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { browserRootSchema, ingestRequestSchema, slugifyProjectName } from "@wrangler/shared";
import { config } from "./config.js";
import { getDestinationSettings, hasSavedDestinationSettings, listMacDirectories, resetDestinationSettings, saveDestinationSettings } from "./destination-settings.js";
import { getAppSettings, saveAppSettings } from "./app-settings.js";
import { createManagedFolder, deleteManagedFolder, listManagedDirectories, listManagedFiles } from "./file-browser.js";
import {
  addJobEvent,
  createInitialUser,
  createJob,
  createSession,
  createProject,
  deleteExpiredSessions,
  deleteAllProjects,
  deleteJob,
  deleteSession,
  getJobById,
  getProjectById,
  getUserBySessionToken,
  hasUsers,
  listCopyRecords,
  listJobEvents,
  listJobs,
  listProjects,
  verifyUserCredentials
} from "./db.js";
import { ensureDirectories, assertInsideRoot } from "./paths.js";
import { buildVolumeThumbnail } from "./thumbnails.js";
import { readVolumeMetadata, suggestAutoImportFolderName } from "./metadata.js";
import { getVolumeOrThrow, listManyVolumeFiles, listVolumeFiles, listVolumes } from "./volume-service.js";

ensureDirectories();

const app = express();
app.use(cors({ origin: config.uiOrigin, credentials: true }));
app.use(express.json({ limit: "2mb" }));
deleteExpiredSessions();

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/auth/status", (request, response) => {
  const user = getAuthenticatedUser(request);
  response.json({
    requiresSetup: !hasUsers(),
    isAuthenticated: Boolean(user),
    username: user?.username ?? null
  });
});

app.get("/settings", (_request, response) => {
  response.json(getAppSettings());
});

app.put("/settings", async (request, response, next) => {
  try {
    response.json(
      await saveAppSettings({
        advancedMetadataEnabled:
          typeof request.body?.advancedMetadataEnabled === "boolean"
            ? request.body.advancedMetadataEnabled
            : undefined
      })
    );
  } catch (error) {
    next(error);
  }
});

app.post("/auth/setup", (request, response, next) => {
  try {
    if (hasUsers()) {
      response.status(400).json({ error: "An account has already been created." });
      return;
    }

    const username = String(request.body?.username ?? "");
    const password = String(request.body?.password ?? "");
    const user = createInitialUser({ username, password });
    const session = createSession(user.id);
    setSessionCookie(response, session.token, session.expiresAt);
    response.status(201).json({ username: user.username });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/login", (request, response, next) => {
  try {
    const username = String(request.body?.username ?? "");
    const password = String(request.body?.password ?? "");
    const user = verifyUserCredentials(username, password);
    if (!user) {
      response.status(401).json({ error: "Invalid username or password." });
      return;
    }

    const session = createSession(user.id);
    setSessionCookie(response, session.token, session.expiresAt);
    response.json({ username: user.username });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/logout", (request, response) => {
  const token = getSessionToken(request);
  if (token) {
    deleteSession(token);
  }
  clearSessionCookie(response);
  response.status(204).send();
});

app.use((request, response, next) => {
  if (request.path === "/health" || request.path.startsWith("/auth/")) {
    next();
    return;
  }

  if (!hasUsers()) {
    response.status(401).json({ error: "Create an account before using Wrangler." });
    return;
  }

  const user = getAuthenticatedUser(request);
  if (!user) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  next();
});

app.get("/volumes", async (_request, response, next) => {
  try {
    response.json(await listVolumes());
  } catch (error) {
    next(error);
  }
});

app.get("/volumes/:id/files", async (request, response, next) => {
  try {
    const volume = await getVolumeOrThrow(request.params.id);
    const relativePath = typeof request.query.path === "string" ? request.query.path : ".";
    response.json(await listVolumeFiles(volume, relativePath));
  } catch (error) {
    next(error);
  }
});

app.get("/volumes/:id/thumbnail", async (request, response, next) => {
  try {
    const volume = await getVolumeOrThrow(request.params.id);
    const relativePath = typeof request.query.path === "string" ? request.query.path : ".";
    const size = Number(request.query.size ?? 320);
    const thumbnail = await buildVolumeThumbnail(volume, relativePath, Number.isFinite(size) ? size : 320);
    if (!thumbnail) {
      response.status(404).json({ error: "Thumbnail not available for this file type." });
      return;
    }

    response.setHeader("Content-Type", "image/jpeg");
    response.setHeader("Cache-Control", "public, max-age=300");
    response.send(thumbnail);
  } catch (error) {
    next(error);
  }
});

app.get("/volumes/:id/metadata", async (request, response, next) => {
  try {
    const volume = await getVolumeOrThrow(request.params.id);
    const relativePath = typeof request.query.path === "string" ? request.query.path : ".";
    const settings = getAppSettings();
    response.json(await readVolumeMetadata(volume, relativePath, { advanced: settings.advancedMetadataEnabled }));
  } catch (error) {
    next(error);
  }
});

app.get("/volumes/:id/auto-import-plan", async (request, response, next) => {
  try {
    const volume = await getVolumeOrThrow(request.params.id);
    const fallbackIndex = Math.max(1, Number(request.query.index ?? 1));
    const entries = await listVolumeFiles(volume, ".");
    response.json({
      volumeId: volume.id,
      suggestedFolderName: await suggestAutoImportFolderName(volume, `Card ${fallbackIndex}`),
      entries: entries.map((entry) => ({
        sourcePath: entry.relativePath
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/volume-browser", async (request, response, next) => {
  try {
    const idsParam = typeof request.query.ids === "string" ? request.query.ids : "";
    const volumeIds = idsParam.split(",").map((item) => item.trim()).filter(Boolean);
    response.json(await listManyVolumeFiles(volumeIds));
  } catch (error) {
    next(error);
  }
});

app.get("/projects", (_request, response) => {
  response.json(listProjects());
});

app.get("/destinations", (_request, response) => {
  response.json({
    ...getDestinationSettings(),
    isConfigured: hasSavedDestinationSettings()
  });
});

app.get("/mac-directories", async (request, response, next) => {
  try {
    const relativePath = typeof request.query.path === "string" ? request.query.path : ".";
    response.json(await listMacDirectories(relativePath));
  } catch (error) {
    next(error);
  }
});

app.put("/destinations", async (request, response, next) => {
  try {
    const nextSettings = await saveDestinationSettings({
      projectRoot: String(request.body?.projectRoot ?? ""),
      destinationA: String(request.body?.destinationA ?? ""),
      destinationB: String(request.body?.destinationB ?? ""),
      destinationBEnabled: Boolean(request.body?.destinationBEnabled),
      destinationC: String(request.body?.destinationC ?? ""),
      destinationCEnabled: Boolean(request.body?.destinationCEnabled)
    });
    response.json({
      ...nextSettings,
      isConfigured: true
    });
  } catch (error) {
    next(error);
  }
});

app.delete("/destinations", async (_request, response, next) => {
  try {
    await resetDestinationSettings();
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/projects", async (request, response, next) => {
  try {
    if (!hasSavedDestinationSettings()) {
      response.status(400).json({ error: "Complete destination setup before creating projects." });
      return;
    }

    const name = String(request.body?.name ?? "").trim();
    if (!name) {
      response.status(400).json({ error: "Project name is required." });
      return;
    }

    const slug = slugifyProjectName(name);
    const destinations = getDestinationSettings();
    const projectPath = assertInsideRoot(destinations.projectRoot, path.join(destinations.projectRoot, slug));
    await fs.mkdir(projectPath, { recursive: true });
    const project = createProject({ name, slug, path: projectPath });
    response.status(201).json(project);
  } catch (error) {
    next(error);
  }
});

app.delete("/projects", async (_request, response, next) => {
  try {
    const projects = listProjects();
    const destinations = getDestinationSettings();

    await Promise.all(
      projects.flatMap((project) => [
        fs.rm(project.path, { recursive: true, force: true }),
        fs.rm(path.join(destinations.destinationA, project.slug), { recursive: true, force: true }),
        fs.rm(path.join(destinations.destinationB, project.slug), { recursive: true, force: true }),
        fs.rm(path.join(destinations.destinationC, project.slug), { recursive: true, force: true })
      ])
    );

    deleteAllProjects();
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/projects/:id/browser", async (request, response, next) => {
  try {
    const project = getProjectById(request.params.id);
    if (!project) {
      response.status(404).json({ error: "Project not found." });
      return;
    }

    const root = browserRootSchema.parse(request.query.root ?? "project");
    const relativePath = typeof request.query.path === "string" ? request.query.path : ".";
    response.json(await listManagedFiles(root, project.slug, relativePath));
  } catch (error) {
    next(error);
  }
});

app.get("/projects/:id/directories", async (request, response, next) => {
  try {
    const project = getProjectById(request.params.id);
    if (!project) {
      response.status(404).json({ error: "Project not found." });
      return;
    }

    const root = browserRootSchema.parse(request.query.root ?? "project");
    response.json(await listManagedDirectories(root, project.slug));
  } catch (error) {
    next(error);
  }
});

app.post("/projects/:id/folders", async (request, response, next) => {
  try {
    const project = getProjectById(request.params.id);
    if (!project) {
      response.status(404).json({ error: "Project not found." });
      return;
    }

    const root = browserRootSchema.parse(request.body?.root ?? "project");
    const relativePath = String(request.body?.path ?? ".");
    const name = String(request.body?.name ?? "").trim();
    if (!name) {
      response.status(400).json({ error: "Folder name is required." });
      return;
    }

    const createdPath = await createManagedFolder(root, project.slug, relativePath, name);
    response.status(201).json({ path: createdPath });
  } catch (error) {
    next(error);
  }
});

app.delete("/projects/:id/folders", async (request, response, next) => {
  try {
    const project = getProjectById(request.params.id);
    if (!project) {
      response.status(404).json({ error: "Project not found." });
      return;
    }

    const root = browserRootSchema.parse(request.query.root ?? "project");
    const relativePath = typeof request.query.path === "string" ? request.query.path : ".";
    if (relativePath === ".") {
      response.status(400).json({ error: "Cannot delete the project root." });
      return;
    }

    await deleteManagedFolder(root, project.slug, relativePath);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.get("/jobs", (_request, response) => {
  response.json(listJobs());
});

app.get("/jobs/:id", (request, response) => {
  const job = getJobById(request.params.id);
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  response.json({
    job,
    project: getProjectById(job.projectId),
    events: listJobEvents(job.id),
    copies: listCopyRecords(job.id)
  });
});

app.delete("/jobs/:id", (request, response, next) => {
  try {
    deleteJob(request.params.id);
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

app.post("/jobs", async (request, response, next) => {
  try {
    if (!hasSavedDestinationSettings()) {
      response.status(400).json({ error: "Complete destination setup before starting an ingest." });
      return;
    }

    const input = ingestRequestSchema.parse(request.body);
    const project = getProjectById(input.projectId);
    if (!project) {
      response.status(404).json({ error: "Project not found." });
      return;
    }

    const job = createJob({
      projectId: input.projectId,
      sources: await Promise.all(
        input.sources.map(async (source) => {
          const volume = await getVolumeOrThrow(source.volumeId);
          const volumeRoot = assertInsideRoot(config.sourceRoot, volume.mountPath);
          const entries = source.entries.map((entry) => ({
            sourcePath: path.normalize(entry.sourcePath),
            targetPath: path.normalize(entry.targetPath || ".")
          }));

          for (const entry of entries) {
            assertInsideRoot(volumeRoot, path.join(volumeRoot, entry.sourcePath));
          }

          return {
            volumeId: source.volumeId,
            sourceRoot: volumeRoot,
            entries
          };
        })
      )
    });

    addJobEvent(job.id, "created", `Created ingest job for project ${project.name}.`);
    response.status(201).json(job);
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  response.status(500).json({ error: message });
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`Wrangler API listening on port ${config.port}`);
});

function getSessionToken(request: express.Request): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";").map((cookie) => cookie.trim());
  for (const cookie of cookies) {
    const [name, ...valueParts] = cookie.split("=");
    if (name === "wrangler_session") {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return null;
}

function getAuthenticatedUser(request: express.Request) {
  const token = getSessionToken(request);
  return token ? getUserBySessionToken(token) : null;
}

function setSessionCookie(response: express.Response, token: string, expiresAt: string): void {
  const expires = new Date(expiresAt).toUTCString();
  response.setHeader("Set-Cookie", `wrangler_session=${encodeURIComponent(token)}; Path=/; Expires=${expires}; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(response: express.Response): void {
  response.setHeader("Set-Cookie", "wrangler_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax");
}
