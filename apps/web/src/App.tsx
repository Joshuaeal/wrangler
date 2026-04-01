import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BrowserRoot, FileEntry, Job, Project, SelectedSourceItem, Volume } from "@wrangler/shared";
import wranglerLogo from "./assets/wrangler-logo-alpha.png";
import raconteurLogo from "./assets/raconteur-logo-alpha.png";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "/api";
const appGitSha = import.meta.env.VITE_APP_GIT_SHA ?? "";
const githubRepo = import.meta.env.VITE_GITHUB_REPO ?? "";
const githubBranch = import.meta.env.VITE_GITHUB_BRANCH ?? "main";

type JobDetails = {
  job: Job;
  project: Project | null;
  events: Array<{ id: string; stage: string; message: string; createdAt: string }>;
  copies: Array<{ id: string; destinationKind: string; relativePath: string; checksum: string | null }>;
};

type Destinations = {
  projectRoot: string;
  destinationA: string;
  destinationB: string;
  destinationBEnabled: boolean;
  destinationC: string;
  destinationCEnabled: boolean;
};

type DestinationSettingsResponse = Destinations & {
  isConfigured: boolean;
};

type AuthStatus = {
  requiresSetup: boolean;
  isAuthenticated: boolean;
  username: string | null;
};

type AppSettings = {
  advancedMetadataEnabled: boolean;
  instanceName: string;
};

type IngestMode = "manual" | "auto";

type AutoImportPlan = {
  volumeId: string;
  entries: Array<{ sourcePath: string }>;
};

type RenameDialogState =
  | { kind: "managed"; relativePath: string; currentName: string }
  | { kind: "auto"; volumeId: string; currentPath: string; currentName: string }
  | null;

type ConfirmDialogState =
  | { kind: "clearProjects"; title: string; message: string; confirmLabel: string }
  | { kind: "shutdown"; title: string; message: string; confirmLabel: string }
  | null;

type MacDirectoryEntry = {
  name: string;
  path: string;
};

type DestinationPreset = {
  label: string;
  path: string;
};

type DestinationDirectoryResponse = {
  currentPath: string;
  directories: MacDirectoryEntry[];
  presets: DestinationPreset[];
};

type DestinationPathField = "projectRoot" | "destinationA" | "destinationB" | "destinationC";

type VolumePane = {
  volume: Volume;
  path: string;
};

type SourceFavorite = {
  volumeId: string;
  volumeName: string;
  path: string;
};

type PooledSourceItem = {
  volumeId: string;
  volumeName: string;
  sourcePath: string;
  targetPath: string;
};

type SourcePreview = {
  volumeId: string;
  volumeName: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  kind: FileEntry["kind"];
  previewable: boolean;
};

type SourceMetadata = {
  fileName: string;
  relativePath: string;
  fileType: string | null;
  mimeType: string | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  reelName: string | null;
  clipName: string | null;
  timecode: string | null;
  createdAt: string | null;
  durationSeconds: number | null;
  frameRate: number | null;
  resolution: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  sampleRate: number | null;
  colorSpace: string | null;
  gamma: string | null;
  iso: number | null;
  shutterSpeed: string | null;
  whiteBalance: string | null;
  aperture: string | null;
  cameraSerialNumber: string | null;
  firmwareVersion: string | null;
  focalLength: string | null;
  scene: string | null;
  take: string | null;
  raw: Record<string, string | number | null>;
};

type UpdateStatus =
  | { state: "idle" | "checking" | "upToDate" | "error" }
  | { state: "available"; latestSha: string };

function parseSummaryProgress(summary: string | null): number | null {
  if (!summary) {
    return null;
  }

  const match = summary.match(/:\s+([\d.]+)\s+([KMGTP]?B)\s+\/\s+([\d.]+)\s+([KMGTP]?B)/i);
  if (!match) {
    return null;
  }

  const current = parseSizeToBytes(Number(match[1]), match[2]);
  const total = parseSizeToBytes(Number(match[3]), match[4]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) {
    return null;
  }

  return Math.max(0, Math.min(1, current / total));
}

function parseSizeToBytes(value: number, unit: string): number {
  const normalizedUnit = unit.toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
    PB: 1024 ** 5
  };
  return value * (multipliers[normalizedUnit] ?? 1);
}

function jobProgressPercent(status: Job["status"], summary: string | null): number {
  const stageProgress = parseSummaryProgress(summary);
  switch (status) {
    case "queued":
      return 0;
    case "scanning":
      return 8;
    case "copyingToProject":
      return 8 + Math.round((stageProgress ?? 0) * 27);
    case "hashingProject":
      return 35 + Math.round((stageProgress ?? 0) * 15);
    case "copyingToDestinations":
      return 50 + Math.round((stageProgress ?? 0) * 25);
    case "verifyingDestinations":
      return 75 + Math.round((stageProgress ?? 0) * 24);
    case "completed":
      return 100;
    case "failed":
    case "cancelled":
      return 100;
    default:
      return 0;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed for ${path}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function getPathChain(currentPath: string): string[] {
  if (currentPath === ".") {
    return ["."];
  }

  const segments = currentPath.split("/").filter(Boolean);
  return [".", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
}

function canPreviewFile(entry: FileEntry): boolean {
  if (entry.kind !== "file") {
    return false;
  }

  return /\.(avif|avi|bmp|gif|heic|heif|jpe?g|m4v|mkv|mov|mp4|png|tiff?|webm|webp)$/i.test(entry.relativePath);
}

function shouldHideSourceEntry(entry: FileEntry): boolean {
  const name = entry.relativePath.split("/").pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? `.${name.split(".").pop()}` : "";
  return (
    name === ".ds_store" ||
    name.startsWith("._") ||
    hiddenSourceExtensions.has(extension)
  );
}

const hiddenSourceExtensions = new Set([
  ".blam",
  ".cfa",
  ".pek",
  ".pkf"
]);

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) {
    return null;
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return [hours, minutes, remainingSeconds].map((value) => value.toString().padStart(2, "0")).join(":");
}

function formatFrameRate(frameRate: number | null): string | null {
  if (frameRate === null || !Number.isFinite(frameRate)) {
    return null;
  }

  return `${frameRate.toFixed(frameRate >= 100 ? 0 : frameRate >= 10 ? 2 : 3)} fps`;
}

function toggleValue(values: string[], nextValue: string): string[] {
  return values.includes(nextValue) ? values.filter((value) => value !== nextValue) : [...values, nextValue];
}

function isHostDestinationPath(value: string): boolean {
  return value.startsWith("/Users") || value.startsWith("/Volumes");
}

export function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [setupUsername, setSetupUsername] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [setupAdvancedMetadata, setSetupAdvancedMetadata] = useState(false);
  const [setupInstanceName, setSetupInstanceName] = useState("");
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [showSettings, setShowSettings] = useState(false);
  const [appSettings, setAppSettings] = useState<AppSettings>({ advancedMetadataEnabled: false, instanceName: "" });
  const [instanceNameDraft, setInstanceNameDraft] = useState("");
  const [ingestMode, setIngestMode] = useState<IngestMode>("manual");
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedVolumeIds, setSelectedVolumeIds] = useState<string[]>([]);
  const [volumePanes, setVolumePanes] = useState<Record<string, VolumePane>>({});
  const [volumeFileCaches, setVolumeFileCaches] = useState<Record<string, Record<string, FileEntry[]>>>({});
  const [selectedByVolume, setSelectedByVolume] = useState<Record<string, string[]>>({});
  const [selectedTargets, setSelectedTargets] = useState<Record<string, string>>({});
  const [projectName, setProjectName] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [jobDetails, setJobDetails] = useState<JobDetails | null>(null);
  const [destinations, setDestinations] = useState<Destinations | null>(null);
  const [draftDestinations, setDraftDestinations] = useState<Destinations | null>(null);
  const [destinationsConfigured, setDestinationsConfigured] = useState(false);
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  const [destinationPickerField, setDestinationPickerField] = useState<DestinationPathField | null>(null);
  const [macDirectoryPath, setMacDirectoryPath] = useState(".");
  const [macDirectoryHistory, setMacDirectoryHistory] = useState<string[]>(["."]);
  const [macDirectoryHistoryIndex, setMacDirectoryHistoryIndex] = useState(0);
  const [macDirectories, setMacDirectories] = useState<MacDirectoryEntry[]>([]);
  const [destinationPresets, setDestinationPresets] = useState<DestinationPreset[]>([]);
  const [managedRoot, setManagedRoot] = useState<BrowserRoot>("project");
  const [managedPath, setManagedPath] = useState(".");
  const [managedFileCache, setManagedFileCache] = useState<Record<string, FileEntry[]>>({});
  const [projectDirectories, setProjectDirectories] = useState<string[]>(["."]);
  const [newFolderName, setNewFolderName] = useState("");
  const [autoFolderNames, setAutoFolderNames] = useState<Record<string, string>>({});
  const [renameDialog, setRenameDialog] = useState<RenameDialogState>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [showJobsPopup, setShowJobsPopup] = useState(false);
  const [showLogsPopup, setShowLogsPopup] = useState(false);
  const [draggedSourceKey, setDraggedSourceKey] = useState<string | null>(null);
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null);
  const [sourceMetadata, setSourceMetadata] = useState<SourceMetadata | null>(null);
  const [sourceMetadataLoading, setSourceMetadataLoading] = useState(false);
  const [sourceFavorites, setSourceFavorites] = useState<SourceFavorite[]>([]);
  const finderColumnsRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const autoFolderNamesRef = useRef<Record<string, string>>({});

  useEffect(() => {
    autoFolderNamesRef.current = autoFolderNames;
  }, [autoFolderNames]);

  useEffect(() => {
    const storedTheme = window.localStorage.getItem("wrangler-theme");
    if (storedTheme === "light" || storedTheme === "dark") {
      setTheme(storedTheme);
    }
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
    window.localStorage.setItem("wrangler-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.title = appSettings.instanceName.trim()
      ? `Wrangler | ${appSettings.instanceName.trim()}`
      : "Wrangler";
  }, [appSettings.instanceName]);

  useEffect(() => {
    setInstanceNameDraft(appSettings.instanceName);
  }, [appSettings.instanceName]);

  useEffect(() => {
    if (!showSettings || !githubRepo || !appGitSha) {
      return;
    }

    let cancelled = false;
    setUpdateStatus({ state: "checking" });

    void fetch(`https://api.github.com/repos/${githubRepo}/commits/${githubBranch}`)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Unable to check for updates.");
        }
        const payload = await response.json() as { sha?: string };
        if (cancelled || !payload.sha) {
          return;
        }

        setUpdateStatus(
          payload.sha.startsWith(appGitSha) || appGitSha.startsWith(payload.sha)
            ? { state: "upToDate" }
            : { state: "available", latestSha: payload.sha.slice(0, 7) }
        );
      })
      .catch(() => {
        if (!cancelled) {
          setUpdateStatus({ state: "error" });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [showSettings]);

  useEffect(() => {
    if (!sourcePreview || sourcePreview.kind !== "file") {
      setSourceMetadata(null);
      setSourceMetadataLoading(false);
      return;
    }

    setSourceMetadataLoading(true);
    void requestJson<SourceMetadata>(`/volumes/${sourcePreview.volumeId}/metadata?path=${encodeURIComponent(sourcePreview.relativePath)}`)
      .then((metadata) => setSourceMetadata(metadata))
      .catch((requestError) => {
        setSourceMetadata(null);
        setError(requestError instanceof Error ? requestError.message : "Unable to load metadata.");
      })
      .finally(() => setSourceMetadataLoading(false));
  }, [sourcePreview]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("wrangler-source-favorites");
      if (!stored) {
        return;
      }

      const parsed = JSON.parse(stored) as SourceFavorite[];
      if (Array.isArray(parsed)) {
        setSourceFavorites(
          parsed.filter(
            (favorite) =>
              typeof favorite?.volumeId === "string" &&
              typeof favorite?.volumeName === "string" &&
              typeof favorite?.path === "string"
          )
        );
      }
    } catch {
      window.localStorage.removeItem("wrangler-source-favorites");
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("wrangler-source-favorites", JSON.stringify(sourceFavorites));
  }, [sourceFavorites]);

  async function refreshAuthStatus(): Promise<AuthStatus | null> {
    try {
      const nextStatus = await requestJson<AuthStatus>("/auth/status");
      setAuthStatus(nextStatus);
      setAuthLoading(false);
      return nextStatus;
    } catch (requestError) {
      setAuthLoading(false);
      setError(requestError instanceof Error ? requestError.message : "Unable to check sign-in status.");
      return null;
    }
  }

  useEffect(() => {
    if (!error) {
      return;
    }

    const timer = window.setTimeout(() => {
      setError(null);
    }, 10000);

    return () => window.clearTimeout(timer);
  }, [error]);

  async function refreshAll() {
    try {
      const [nextVolumes, nextProjects, nextJobs, nextDestinations, nextAppSettings] = await Promise.all([
        requestJson<Volume[]>("/volumes"),
        requestJson<Project[]>("/projects"),
        requestJson<Job[]>("/jobs"),
        requestJson<DestinationSettingsResponse>("/destinations"),
        requestJson<AppSettings>("/settings")
      ]);

      setVolumes(nextVolumes);
      setProjects(nextProjects);
      setJobs(nextJobs);
      setDestinations(nextDestinations);
      setAppSettings(nextAppSettings);
      setDestinationsConfigured(nextDestinations.isConfigured);
      setDraftDestinations((current) => current ?? nextDestinations);
      if (!selectedProjectId && nextProjects[0]) {
        setSelectedProjectId(nextProjects[0].id);
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Unable to refresh.";
      if (message === "Authentication required.") {
        await refreshAuthStatus();
        return;
      }
      setError(message);
    }
  }

  useEffect(() => {
    void refreshAuthStatus();
  }, []);

  useEffect(() => {
    if (!authStatus?.isAuthenticated) {
      return;
    }

    void refreshAll();
    const timer = window.setInterval(() => {
      void refreshAll();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [authStatus?.isAuthenticated]);

  useEffect(() => {
    if (selectedVolumeIds.length === 0) {
      setVolumePanes({});
      return;
    }

    const nextPanes: Record<string, VolumePane> = {};
    for (const volumeId of selectedVolumeIds) {
      const volume = volumes.find((item) => item.id === volumeId);
      if (!volume) {
        continue;
      }

      nextPanes[volumeId] = volumePanes[volumeId] ?? {
        volume,
        path: "."
      };
    }

    setVolumePanes(nextPanes);
  }, [selectedVolumeIds, volumes]);

  const volumePaneKeys = useMemo(
    () =>
      Object.values(volumePanes)
        .map((pane) => `${pane.volume.id}:${pane.path}`)
        .sort()
        .join("|"),
    [volumePanes]
  );

  useLayoutEffect(() => {
    const frameHandles: number[] = [];
    const timeoutHandles: number[] = [];

    const forceScrollRight = (container: HTMLDivElement) => {
      const lastColumn = container.lastElementChild as HTMLElement | null;
      if (lastColumn) {
        lastColumn.scrollIntoView({ block: "nearest", inline: "end" });
      }
      container.scrollLeft = container.scrollWidth;
    };

    for (const pane of Object.values(volumePanes)) {
      const container = finderColumnsRefs.current[pane.volume.id];
      if (!container) {
        continue;
      }

      container.scrollTop = 0;
      forceScrollRight(container);

      const firstFrame = window.requestAnimationFrame(() => {
        container.scrollTop = 0;
        forceScrollRight(container);
        const secondFrame = window.requestAnimationFrame(() => {
          forceScrollRight(container);
        });
        frameHandles.push(secondFrame);
      });
      frameHandles.push(firstFrame);

      timeoutHandles.push(
        window.setTimeout(() => {
          container.scrollTop = 0;
          forceScrollRight(container);
        }, 40)
      );
    }

    return () => {
      for (const handle of frameHandles) {
        window.cancelAnimationFrame(handle);
      }
      for (const handle of timeoutHandles) {
        window.clearTimeout(handle);
      }
    };
  }, [volumePaneKeys]);

  useEffect(() => {
    for (const pane of Object.values(volumePanes)) {
      for (const pathEntry of getPathChain(pane.path)) {
        if (volumeFileCaches[pane.volume.id]?.[pathEntry]) {
          continue;
        }

        void requestJson<FileEntry[]>(
          `/volumes/${pane.volume.id}/files?path=${encodeURIComponent(pathEntry)}`
        )
          .then((result) => {
            setVolumeFileCaches((current) => ({
              ...current,
              [pane.volume.id]: {
                ...(current[pane.volume.id] ?? {}),
                [pathEntry]: result
              }
            }));
          })
          .catch((requestError) => {
            setError(requestError instanceof Error ? requestError.message : "Unable to list source files.");
          });
      }
    }
  }, [volumePaneKeys]);

  useEffect(() => {
    if (!selectedProjectId) {
      setManagedFileCache({});
      setProjectDirectories(["."]);
      return;
    }
    void refreshManagedPath(managedPath);
  }, [managedPath, managedRoot, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    void requestJson<string[]>(
      `/projects/${selectedProjectId}/directories?root=${managedRoot}`
    )
      .then((directories) => setProjectDirectories(directories))
      .catch((requestError) => {
        setError(requestError instanceof Error ? requestError.message : "Unable to list project directories.");
      });
  }, [managedRoot, selectedProjectId, managedFileCache]);

  useEffect(() => {
    if (!showDestinationPicker) {
      return;
    }

    void requestJson<DestinationDirectoryResponse>(
      `/mac-directories?path=${encodeURIComponent(macDirectoryPath)}`
    )
      .then((result) => {
        setMacDirectoryPath(result.currentPath);
        setMacDirectories(result.directories);
        setDestinationPresets(result.presets);
      })
      .catch((requestError) => {
        setError(requestError instanceof Error ? requestError.message : "Unable to browse Mac directories.");
      });
  }, [macDirectoryPath, showDestinationPicker]);

  async function createProject() {
    if (!destinationsConfigured) {
      setError("Choose your destination folders to finish setup before creating projects.");
      return;
    }

    try {
      const project = await requestJson<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ name: projectName })
      });

      setProjectName("");
      setSelectedProjectId(project.id);
      await refreshAll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create project.");
    }
  }

  async function createAccount() {
    try {
      await requestJson<{ username: string }>("/auth/setup", {
        method: "POST",
        body: JSON.stringify({ username: setupUsername, password: setupPassword })
      });
      const savedSettings = await requestJson<AppSettings>("/settings", {
        method: "PUT",
        body: JSON.stringify({
          advancedMetadataEnabled: setupAdvancedMetadata,
          instanceName: setupInstanceName
        })
      });
      setAppSettings(savedSettings);
      setSetupPassword("");
      setLoginPassword("");
      await refreshAuthStatus();
      await refreshAll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create account.");
    }
  }

  async function login() {
    try {
      await requestJson<{ username: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: loginUsername, password: loginPassword })
      });
      setLoginPassword("");
      await refreshAuthStatus();
      await refreshAll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to sign in.");
    }
  }

  async function logout() {
    try {
      await requestJson<void>("/auth/logout", { method: "POST" });
      setAuthStatus((current) => current ? { ...current, isAuthenticated: false, username: null } : current);
      setVolumes([]);
      setProjects([]);
      setJobs([]);
      setSelectedProjectId("");
      setJobDetails(null);
      setShowSettings(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to sign out.");
    }
  }

  async function persistAppSettings(nextSettings: Partial<AppSettings>) {
    try {
      const saved = await requestJson<AppSettings>("/settings", {
        method: "PUT",
        body: JSON.stringify(nextSettings)
      });
      setAppSettings(saved);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save settings.");
    }
  }

  async function saveSetupInstanceName() {
    try {
      const saved = await requestJson<AppSettings>("/settings", {
        method: "PUT",
        body: JSON.stringify({ instanceName: setupInstanceName })
      });
      setAppSettings(saved);
      setSetupInstanceName(saved.instanceName);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save instance name.");
    }
  }

  async function clearProjects() {
    try {
      await requestJson<void>("/projects", { method: "DELETE" });
      setSelectedProjectId("");
      setManagedFileCache({});
      setManagedPath(".");
      setProjectDirectories(["."]);
      setJobDetails(null);
      setSelectedByVolume({});
      setSelectedTargets({});
      await refreshAll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to clear projects.");
    }
  }

  async function startJob() {
    if (!destinationsConfigured) {
      setError("Choose your destination folders to finish setup before starting an ingest.");
      return;
    }

    try {
      const job = await requestJson<Job>("/jobs", {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId,
          sources: buildSourcePayload()
        })
      });

      await refreshAll();
      await inspectJob(job.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to start ingest.");
    }
  }

  async function inspectJob(jobId: string, options?: { openLogs?: boolean }) {
    try {
      const details = await requestJson<JobDetails>(`/jobs/${jobId}`);
      setJobDetails(details);
      if (options?.openLogs) {
        setShowLogsPopup(true);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to load job details.");
    }
  }

  async function removeJob(jobId: string) {
    try {
      await requestJson<void>(`/jobs/${jobId}`, { method: "DELETE" });
      if (jobDetails?.job.id === jobId) {
        setJobDetails(null);
      }
      await refreshAll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to remove job.");
    }
  }

  async function cancelJob(jobId: string) {
    try {
      await requestJson<void>(`/jobs/${jobId}/cancel`, { method: "POST" });
      if (jobDetails?.job.id === jobId) {
        await inspectJob(jobId);
      }
      await refreshAll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to cancel job.");
    }
  }

  async function shutdownWrangler() {
    try {
      await requestJson<void>("/system/shutdown", { method: "POST" });
      setShowSettings(false);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to stop Wrangler.");
    }
  }

  async function persistDestinations(nextDestinations: Destinations) {
    try {
      setDraftDestinations(nextDestinations);
      const saved = await requestJson<DestinationSettingsResponse>("/destinations", {
        method: "PUT",
        body: JSON.stringify(nextDestinations)
      });
      setDestinations(saved);
      setDestinationsConfigured(saved.isConfigured);
      setDraftDestinations(saved);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to save destinations.");
    }
  }

  async function finishSetup() {
    if (!draftDestinations) {
      return;
    }

    if (!isHostDestinationPath(draftDestinations.projectRoot) || !isHostDestinationPath(draftDestinations.destinationA)) {
      setError("Choose both Project Root and Destination A before finishing setup.");
      return;
    }

    await persistDestinations(draftDestinations);
  }

  async function resetDestinations() {
    try {
      const username = authStatus?.username?.trim();
      if (!username) {
        throw new Error("No authenticated user found.");
      }
      await requestJson<{ username: string }>("/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password: resetPassword })
      });
      await requestJson<void>("/destinations", { method: "DELETE" });
      setDestinationsConfigured(false);
      setDestinations(null);
      setDraftDestinations({
        projectRoot: "/storage/projects",
        destinationA: "/storage/destination-a",
        destinationB: "/storage/destination-b",
        destinationBEnabled: false,
        destinationC: "/storage/destination-c",
        destinationCEnabled: false
      });
      setShowDestinationPicker(false);
      setDestinationPickerField(null);
      setMacDirectoryPath(".");
      setDestinationPresets([]);
      setResetPassword("");
      setShowSettings(false);
      await refreshAll();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to reset destinations.");
    }
  }

  function openDestinationPicker(field: DestinationPathField) {
    setDestinationPickerField(field);
    const currentPath = draftDestinations?.[field];
    const nextPath =
      typeof currentPath === "string" &&
      (currentPath.startsWith("/Users") || currentPath.startsWith("/Volumes")) &&
      currentPath.length > 0
        ? currentPath
        : ".";
    setMacDirectoryPath(nextPath);
    setMacDirectoryHistory([nextPath]);
    setMacDirectoryHistoryIndex(0);
    setShowDestinationPicker(true);
  }

  function navigateDestinationPicker(nextPath: string) {
    setMacDirectoryPath(nextPath);
    setMacDirectoryHistory((current) => {
      const nextHistory = current.slice(0, macDirectoryHistoryIndex + 1);
      if (nextHistory[nextHistory.length - 1] !== nextPath) {
        nextHistory.push(nextPath);
      }
      setMacDirectoryHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }

  function goDestinationBack() {
    if (macDirectoryHistoryIndex <= 0) {
      return;
    }
    const nextIndex = macDirectoryHistoryIndex - 1;
    setMacDirectoryHistoryIndex(nextIndex);
    setMacDirectoryPath(macDirectoryHistory[nextIndex] ?? ".");
  }

  function goDestinationForward() {
    if (macDirectoryHistoryIndex >= macDirectoryHistory.length - 1) {
      return;
    }
    const nextIndex = macDirectoryHistoryIndex + 1;
    setMacDirectoryHistoryIndex(nextIndex);
    setMacDirectoryPath(macDirectoryHistory[nextIndex] ?? ".");
  }

  function applyPickedDestination(selectedPath: string) {
    if (!draftDestinations || !destinationPickerField) {
      return;
    }

    const nextDestinations = {
      ...draftDestinations,
      [destinationPickerField]: selectedPath
    };
    setDraftDestinations(nextDestinations);
    setShowDestinationPicker(false);
    setDestinationPickerField(null);
  }

  async function createManagedFolder() {
    if (!selectedProjectId || !newFolderName.trim() || managedRoot !== "project") {
      return;
    }

    try {
      await requestJson<{ path: string }>(`/projects/${selectedProjectId}/folders`, {
        method: "POST",
        body: JSON.stringify({
          root: managedRoot,
          path: managedPath,
          name: newFolderName
        })
      });
      setNewFolderName("");
      await refreshManagedPath(managedPath);
      const directories = await requestJson<string[]>(`/projects/${selectedProjectId}/directories?root=${managedRoot}`);
      setProjectDirectories(directories);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to create folder.");
    }
  }

  async function ensureProjectFolderExists(relativePath: string) {
    if (!selectedProjectId || relativePath === ".") {
      return;
    }

    const folderName = relativePath.split("/").pop()?.trim();
    const parentPath = navigateUp(relativePath);
    if (!folderName) {
      return;
    }

    await requestJson<{ path: string }>(`/projects/${selectedProjectId}/folders`, {
      method: "POST",
      body: JSON.stringify({
        root: "project",
        path: parentPath,
        name: folderName
      })
    });
  }

  async function renameProjectFolderPath(relativePath: string, nextPath: string) {
    if (!selectedProjectId || relativePath === "." || nextPath === "." || relativePath === nextPath) {
      return;
    }

    const nextName = nextPath.split("/").pop()?.trim();
    if (!nextName) {
      return;
    }

    await requestJson<{ path: string }>(`/projects/${selectedProjectId}/folders`, {
      method: "PATCH",
      body: JSON.stringify({
        root: "project",
        path: relativePath,
        name: nextName
      })
    });
  }

  async function renameManagedFolder(relativePath: string, nextName: string) {
    if (!selectedProjectId || managedRoot !== "project") {
      return;
    }

    try {
      const result = await requestJson<{ path: string }>(`/projects/${selectedProjectId}/folders`, {
        method: "PATCH",
        body: JSON.stringify({
          root: managedRoot,
          path: relativePath,
          name: nextName
        })
      });

      setManagedFileCache({});
      const nextManagedPath =
        managedPath === relativePath || managedPath.startsWith(`${relativePath}/`)
          ? managedPath.replace(relativePath, result.path)
          : managedPath;
      setManagedPath(nextManagedPath);
      await refreshManagedPath(nextManagedPath);
      const directories = await requestJson<string[]>(`/projects/${selectedProjectId}/directories?root=${managedRoot}`);
      setProjectDirectories(directories);
      setSelectedTargets((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, value]) => {
            if (value === relativePath || value.startsWith(`${relativePath}/`)) {
              return [key, value.replace(relativePath, result.path)];
            }
            return [key, value];
          })
        )
      );
      setAutoFolderNames((current) =>
        Object.fromEntries(
          Object.entries(current).map(([volumeId, value]) => [volumeId, value === relativePath ? result.path : value])
        )
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to rename folder.");
    }
  }

  async function deleteManagedFolder(relativePath: string) {
    if (!selectedProjectId || managedRoot !== "project") {
      return;
    }

    try {
      const response = await fetch(
        `${apiBase}/projects/${selectedProjectId}/folders?root=${managedRoot}&path=${encodeURIComponent(relativePath)}`,
        { method: "DELETE" }
      );
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? "Unable to delete folder.");
      }
      if (managedPath === relativePath || managedPath.startsWith(`${relativePath}/`)) {
        setManagedPath(navigateUp(relativePath));
      }
      setManagedFileCache({});
      await refreshManagedPath(managedPath === relativePath || managedPath.startsWith(`${relativePath}/`) ? navigateUp(relativePath) : managedPath);
      const directories = await requestJson<string[]>(`/projects/${selectedProjectId}/directories?root=${managedRoot}`);
      setProjectDirectories(directories);
      setAutoFolderNames((current) =>
        Object.fromEntries(Object.entries(current).filter(([, value]) => value !== relativePath))
      );
      setSelectedTargets((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, value]) => [key, value === relativePath ? "." : value])
        )
      );
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to delete folder.");
    }
  }

  async function refreshManagedPath(nextPath: string) {
    if (!selectedProjectId) {
      return;
    }

    const refreshed = await requestJson<FileEntry[]>(
      `/projects/${selectedProjectId}/browser?root=${managedRoot}&path=${encodeURIComponent(nextPath)}`
    );
    setManagedFileCache((current) => ({
      ...current,
      [nextPath]: refreshed
    }));
  }

  function navigateUp(currentPath: string): string {
    return currentPath === "." ? "." : currentPath.split("/").slice(0, -1).join("/") || ".";
  }

  function navigateVolume(volumeId: string, nextPath: string) {
    setVolumePanes((current) => ({
      ...current,
      [volumeId]: {
        ...current[volumeId],
        path: nextPath
      }
    }));
  }

  function sourceKey(volumeId: string, sourcePath: string): string {
    return `${volumeId}:${sourcePath}`;
  }

  function getAssignedTarget(volumeId: string, sourcePath: string): string {
    const key = sourceKey(volumeId, sourcePath);
    return selectedTargets[key] ?? ".";
  }

  function toggleSelectedSource(volumeId: string, sourcePath: string, checked: boolean) {
    setSelectedByVolume((current) => {
      const existing = current[volumeId] ?? [];
      return {
        ...current,
        [volumeId]: checked
          ? existing.includes(sourcePath)
            ? existing
            : [...existing, sourcePath].sort()
          : existing.filter((item) => item !== sourcePath)
      };
    });

    if (checked) {
      setSelectedTargets((current) => ({
        ...current,
        [sourceKey(volumeId, sourcePath)]: current[sourceKey(volumeId, sourcePath)] ?? "."
      }));
      return;
    }

    setSelectedTargets((current) => {
      const next = { ...current };
      delete next[sourceKey(volumeId, sourcePath)];
      return next;
    });
  }

  function assignTargetToSource(volumeId: string, sourcePath: string, targetPath: string) {
    setSelectedTargets((current) => ({
      ...current,
      [sourceKey(volumeId, sourcePath)]: targetPath
    }));
  }

  async function assignTargetToVolume(volumeId: string, targetPath: string) {
    const volumeEntries = selectedByVolume[volumeId] ?? [];
    const currentTargetPath = autoFolderNames[volumeId];
    const normalizedTargetPath = targetPath.trim() || ".";

    try {
      if (currentTargetPath && currentTargetPath !== normalizedTargetPath) {
        await renameProjectFolderPath(currentTargetPath, normalizedTargetPath);
      } else if (!currentTargetPath && normalizedTargetPath !== ".") {
        await ensureProjectFolderExists(normalizedTargetPath);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to update auto-import folder.");
      return;
    }

    setSelectedTargets((current) => {
      const next = { ...current };
      for (const sourcePath of volumeEntries) {
        next[sourceKey(volumeId, sourcePath)] = normalizedTargetPath;
      }
      return next;
    });
    setAutoFolderNames((current) => ({
      ...current,
      [volumeId]: normalizedTargetPath
    }));
    setProjectDirectories((current) =>
      [...new Set([...current.filter((directory) => directory !== currentTargetPath), normalizedTargetPath])].sort((left, right) =>
        left.localeCompare(right)
      )
    );
    setManagedFileCache({});
    if (managedRoot === "project") {
      await refreshManagedPath(managedPath);
      const directories = await requestJson<string[]>(`/projects/${selectedProjectId}/directories?root=project`);
      setProjectDirectories(directories);
    }
  }

  function openRenameDialog(dialog: Exclude<RenameDialogState, null>) {
    setRenameDialog(dialog);
    setRenameValue(dialog.currentName);
  }

  function closeRenameDialog() {
    setRenameDialog(null);
    setRenameValue("");
  }

  async function submitRenameDialog() {
    if (!renameDialog) {
      return;
    }

    const nextName = renameValue.trim();
    if (!nextName || nextName === renameDialog.currentName) {
      closeRenameDialog();
      return;
    }

    try {
      if (renameDialog.kind === "managed") {
        await renameManagedFolder(renameDialog.relativePath, nextName);
      } else {
        const parentPath = navigateUp(renameDialog.currentPath);
        const nextPath = parentPath === "." ? nextName : `${parentPath}/${nextName}`;
        await assignTargetToVolume(renameDialog.volumeId, nextPath);
      }
      closeRenameDialog();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Unable to rename folder.");
    }
  }

  async function submitConfirmDialog() {
    if (!confirmDialog) {
      return;
    }

    const dialog = confirmDialog;
    setConfirmDialog(null);

    if (dialog.kind === "clearProjects") {
      await clearProjects();
      return;
    }

    if (dialog.kind === "shutdown") {
      await shutdownWrangler();
      return;
    }

  }

  function removePooledSource(volumeId: string, sourcePath: string) {
    toggleSelectedSource(volumeId, sourcePath, false);
  }

  function buildSourcePayload(): Array<{ volumeId: string; sourceRoot: string; entries: SelectedSourceItem[] }> {
    return selectedVolumeIds
      .map((volumeId) => ({
        volumeId,
        sourceRoot: "",
        entries: (selectedByVolume[volumeId] ?? []).map((sourcePath) => ({
          sourcePath,
          targetPath: getAssignedTarget(volumeId, sourcePath)
        }))
      }))
      .filter((source) => source.entries.length > 0);
  }

  const canStart = useMemo(
    () =>
      Boolean(
        destinationsConfigured &&
        selectedProjectId &&
        selectedVolumeIds.length > 0 &&
        (ingestMode === "auto" || selectedVolumeIds.some((volumeId) => (selectedByVolume[volumeId] ?? []).length > 0))
      ),
    [destinationsConfigured, ingestMode, selectedByVolume, selectedProjectId, selectedVolumeIds]
  );

  const managedPathChain = useMemo(() => getPathChain(managedPath), [managedPath]);

  function toggleSourceFavorite(volumeId: string, volumeName: string, favoritePath: string) {
    setSourceFavorites((current) => {
      const exists = current.some((favorite) => favorite.volumeId === volumeId && favorite.path === favoritePath);
      if (exists) {
        return current.filter((favorite) => !(favorite.volumeId === volumeId && favorite.path === favoritePath));
      }

      return [...current, { volumeId, volumeName, path: favoritePath }].sort((left, right) =>
        `${left.volumeName}:${left.path}`.localeCompare(`${right.volumeName}:${right.path}`)
      );
    });
  }

  function removeSourceFavorite(volumeId: string, favoritePath: string) {
    setSourceFavorites((current) =>
      current.filter((favorite) => !(favorite.volumeId === volumeId && favorite.path === favoritePath))
    );
  }

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    for (const pathEntry of managedPathChain) {
      if (managedFileCache[pathEntry]) {
        continue;
      }

      void requestJson<FileEntry[]>(
        `/projects/${selectedProjectId}/browser?root=${managedRoot}&path=${encodeURIComponent(pathEntry)}`
      )
        .then((result) => {
          setManagedFileCache((current) => ({
            ...current,
            [pathEntry]: result
          }));
        })
        .catch((requestError) => {
          setError(requestError instanceof Error ? requestError.message : "Unable to browse project folders.");
        });
    }
  }, [managedPathChain, managedRoot, selectedProjectId]);

  const pooledSources = useMemo<PooledSourceItem[]>(
    () =>
      selectedVolumeIds
        .flatMap((volumeId) => {
          const volume = volumes.find((item) => item.id === volumeId);
          if (!volume) {
            return [];
          }

          return (selectedByVolume[volumeId] ?? []).map((sourcePath) => ({
            volumeId,
            volumeName: volume.name,
            sourcePath,
            targetPath: getAssignedTarget(volumeId, sourcePath)
          }));
        }),
    [selectedByVolume, selectedTargets, selectedVolumeIds, volumes]
  );

  useEffect(() => {
    if (ingestMode !== "auto" || selectedVolumeIds.length === 0) {
      return;
    }

    let cancelled = false;

    void Promise.all(
      selectedVolumeIds.map((volumeId) => requestJson<AutoImportPlan>(`/volumes/${volumeId}/auto-import-plan`))
    )
      .then((plans) => {
        if (cancelled) {
          return;
        }

        const nextSelectedByVolume: Record<string, string[]> = {};
        const nextSelectedTargets: Record<string, string> = {};
        const nextAutoFolderNames: Record<string, string> = {};

        for (const [index, plan] of plans.entries()) {
          const targetFolder = autoFolderNamesRef.current[plan.volumeId] ?? String(index + 1);
          nextSelectedByVolume[plan.volumeId] = plan.entries.map((entry) => entry.sourcePath).sort();
          nextAutoFolderNames[plan.volumeId] = targetFolder;
          for (const entry of plan.entries) {
            nextSelectedTargets[sourceKey(plan.volumeId, entry.sourcePath)] = targetFolder;
          }
        }

        setSelectedByVolume((current) => ({
          ...current,
          ...nextSelectedByVolume
        }));
        setSelectedTargets((current) => {
          const preservedManualEntries = Object.fromEntries(
            Object.entries(current).filter(([key]) => {
              const volumeId = key.split(":")[0];
              return !selectedVolumeIds.includes(volumeId);
            })
          );
          return {
            ...preservedManualEntries,
            ...nextSelectedTargets
          };
        });
        setAutoFolderNames((current) => {
          const next: Record<string, string> = {};
          for (const volumeId of selectedVolumeIds) {
            if (nextAutoFolderNames[volumeId]) {
              next[volumeId] = nextAutoFolderNames[volumeId];
            } else if (current[volumeId]) {
              next[volumeId] = current[volumeId];
            }
          }
          return next;
        });
        setProjectDirectories((current) => {
          const next = new Set(current);
          for (const folderName of Object.values(nextAutoFolderNames)) {
            next.add(folderName);
          }
          return [...next].sort((left, right) => left.localeCompare(right));
        });
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to build auto import pool.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ingestMode, selectedVolumeIds]);

  useEffect(() => {
    setAutoFolderNames((current) =>
      Object.fromEntries(Object.entries(current).filter(([volumeId]) => selectedVolumeIds.includes(volumeId)))
    );
  }, [selectedVolumeIds]);

  useEffect(() => {
    if (managedRoot !== "project") {
      setManagedRoot("project");
    }
  }, [managedRoot]);

  useEffect(() => {
    if (!selectedProjectId || ingestMode !== "auto") {
      return;
    }

    const folderNames = [...new Set(Object.values(autoFolderNames).filter((folderName) => folderName && folderName !== "."))];
    if (folderNames.length === 0) {
      return;
    }

    let cancelled = false;

    void Promise.all(folderNames.map((folderName) => ensureProjectFolderExists(folderName)))
      .then(async () => {
        if (cancelled) {
          return;
        }
        setManagedFileCache({});
        if (managedRoot === "project") {
          await refreshManagedPath(managedPath);
        }
        const directories = await requestJson<string[]>(`/projects/${selectedProjectId}/directories?root=project`);
        if (!cancelled) {
          setProjectDirectories(directories);
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : "Unable to prepare auto-import folders.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [autoFolderNames, ingestMode, managedPath, managedRoot, selectedProjectId]);

  const availableManagedRoots = useMemo<Array<{ value: BrowserRoot; label: string }>>(() => {
    const rootOptions: Array<{ value: BrowserRoot; label: string }> = [
      { value: "project", label: "Project" },
      { value: "destA", label: "Destination A" }
    ];

    if (draftDestinations?.destinationBEnabled) {
      rootOptions.push({ value: "destB", label: "Destination B" });
    }

    if (draftDestinations?.destinationCEnabled) {
      rootOptions.push({ value: "destC", label: "Destination C" });
    }

    return rootOptions;
  }, [draftDestinations]);

  useEffect(() => {
    if (availableManagedRoots.some((root) => root.value === managedRoot)) {
      return;
    }

    setManagedRoot("project");
    setManagedPath(".");
    setManagedFileCache({});
  }, [availableManagedRoots, managedRoot]);

  if (authLoading) {
    return (
      <main className="layout authLayout">
        <div className="brandHeader">
          <img className="brandLogo" src={wranglerLogo} alt="Wrangler" />
        </div>
        <section className="authCard panel">
          <h2>Loading Wrangler</h2>
          <p className="muted">Checking account status...</p>
        </section>
      </main>
    );
  }

  if (!authStatus?.isAuthenticated) {
    const isSetup = authStatus?.requiresSetup ?? true;
    return (
      <main className="layout authLayout">
        <div className="brandHeader">
          <img className="brandLogo" src={wranglerLogo} alt="Wrangler" />
        </div>
        <section className="authCard panel">
          <h2>{isSetup ? "Create Admin Account" : "Sign In"}</h2>
          <p className="muted">
            {isSetup
              ? "Create the first local admin account for this Wrangler install."
              : "Sign in with the local admin account to access this session."}
          </p>
          <div className="stack">
            <label className="authField">
              <span>Username</span>
              <input
                value={isSetup ? setupUsername : loginUsername}
                onChange={(event) => (isSetup ? setSetupUsername(event.target.value) : setLoginUsername(event.target.value))}
                placeholder="admin"
              />
            </label>
            <label className="authField">
              <span>Password</span>
              <input
                type="password"
                value={isSetup ? setupPassword : loginPassword}
                onChange={(event) => (isSetup ? setSetupPassword(event.target.value) : setLoginPassword(event.target.value))}
                placeholder={isSetup ? "Minimum 8 characters" : "Password"}
              />
            </label>
            {isSetup ? (
              <label className={`authCheckbox ${setupAdvancedMetadata ? "authCheckboxSelected" : ""}`}>
                <input
                  type="checkbox"
                  checked={setupAdvancedMetadata}
                  onChange={(event) => setSetupAdvancedMetadata(event.target.checked)}
                />
                <span>Enable advanced camera metadata parsing on this install</span>
              </label>
            ) : null}
            <div className="pickerActions">
              <button
                type="button"
                className="startIngestButton"
                onClick={() => void (isSetup ? createAccount() : login())}
                disabled={!(isSetup ? setupUsername.trim() && setupPassword.length >= 8 : loginUsername.trim() && loginPassword)}
              >
                {isSetup ? "Create Account" : "Login"}
              </button>
              <select value={theme} onChange={(event) => setTheme(event.target.value as "dark" | "light")}>
                <option value="dark">Dark Theme</option>
                <option value="light">Light Theme</option>
              </select>
            </div>
          </div>
        </section>
        {error ? (
          <button type="button" className="errorToast" onClick={() => setError(null)} aria-label="Dismiss error">
            <span className="errorToastLabel">Error</span>
            <span>{error}</span>
            <span className="errorToastHint">Click to dismiss</span>
          </button>
        ) : null}
      </main>
    );
  }

  return (
    <main className="layout">
      <header>
        <div className="brandHeader">
          <img className="brandLogo" src={wranglerLogo} alt="Wrangler" />
        </div>
      </header>

      <section className="workflowSection workflowSectionSplit">
        <article className="panel">
          <h2>Projects</h2>
          <div className="stack">
            <input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="New project name" />
            <div className="modeTabs" role="tablist" aria-label="Ingest mode">
              <button
                type="button"
                className={`modeTab ${ingestMode === "manual" ? "modeTabActive" : ""}`}
                onClick={() => setIngestMode("manual")}
              >
                Manual
              </button>
              <button
                type="button"
                className={`modeTab ${ingestMode === "auto" ? "modeTabActive" : ""}`}
                onClick={() => setIngestMode("auto")}
              >
                Auto
              </button>
            </div>
            <div className="muted">
              {ingestMode === "manual"
                ? "Manual mode lets you pick files and folders into the source pool."
                : "Auto mode imports all visible files from each selected card into separate folders in the project."}
            </div>
            <div className="pickerActions">
              <button onClick={createProject} disabled={!projectName.trim() || !destinationsConfigured}>
                Create Project
              </button>
              <button
                className="dangerButton"
                onClick={() =>
                  setConfirmDialog({
                    kind: "clearProjects",
                    title: "Clear Projects",
                    message: "Clear all projects and related job history from Wrangler without deleting folders already written to disk?",
                    confirmLabel: "Clear Projects"
                  })
                }
                disabled={projects.length === 0}
              >
                Clear Projects
              </button>
            </div>
            <select value={selectedProjectId} onChange={(event) => setSelectedProjectId(event.target.value)}>
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
        </article>

        <article className="panel">
          <div className="sectionTitleRow">
            <h2>Source Volumes</h2>
            <span className="infoHint" data-tooltip="Detected on the host helper service. Click any volume row to include or remove it from this ingest.">
              ?
            </span>
          </div>
          <div className="stack">
            {volumes.map((volume) => {
              const checked = selectedVolumeIds.includes(volume.id);
              return (
                <button
                  key={volume.id}
                  type="button"
                  className={`checkRow checkCard ${checked ? "checkRowSelected" : ""}`}
                  onClick={() => setSelectedVolumeIds((current) => toggleValue(current, volume.id))}
                >
                  <span>{volume.name}</span>
                  <small>{volume.mountPath}</small>
                </button>
              );
            })}
          </div>
        </article>
      </section>

      <section className="workflowSection">
        <article className="panel sourceBrowserPanel">
          <div className="sectionTitleRow">
            <h2>Source Browser</h2>
            <span className="infoHint" data-tooltip="Browse each selected source volume, add files or folders into the pool, and click previewable media to inspect it.">
              ?
            </span>
          </div>
          <div className="sourceBrowserLayout">
            <div className="sourceBrowserScroller">
              <div className="browserGrid">
              {Object.values(volumePanes).map((pane) => (
                <article
                  key={pane.volume.id}
                  className="subPanel"
                >
                  <h3>{pane.volume.name}</h3>
                  <div className="muted">{pane.volume.mountPath}</div>
                  <div className="paneToolbar">
                    <code>{pane.path}</code>
                    <div className="pickerActions">
                      <button onClick={() => navigateVolume(pane.volume.id, ".")}>Root</button>
                      <button
                        onClick={() => navigateVolume(pane.volume.id, navigateUp(pane.path))}
                        disabled={pane.path === "."}
                      >
                        Up
                      </button>
                      <button onClick={() => toggleSourceFavorite(pane.volume.id, pane.volume.name, pane.path)}>
                        {sourceFavorites.some((favorite) => favorite.volumeId === pane.volume.id && favorite.path === pane.path)
                          ? "Remove Favorite"
                          : "Add Favorite"}
                      </button>
                    </div>
                  </div>
                  {sourceFavorites.some((favorite) => favorite.volumeId === pane.volume.id) ? (
                    <div className="sourceFavoriteList">
                      {sourceFavorites
                        .filter((favorite) => favorite.volumeId === pane.volume.id)
                        .map((favorite) => (
                          <div key={`${favorite.volumeId}:${favorite.path}`} className="sourceFavoriteItem">
                            <button type="button" className="sourceFavoriteButton" onClick={() => navigateVolume(pane.volume.id, favorite.path)}>
                              {favorite.path === "." ? "Root" : favorite.path}
                            </button>
                            <button type="button" className="sourceFavoriteRemove" onClick={() => removeSourceFavorite(pane.volume.id, favorite.path)}>
                              Remove
                            </button>
                          </div>
                        ))}
                    </div>
                  ) : null}
                  <div
                    className="finderColumns"
                    ref={(element) => {
                      finderColumnsRefs.current[pane.volume.id] = element;
                    }}
                  >
                    {getPathChain(pane.path).map((pathEntry) => (
                      <div key={`${pane.volume.id}:${pathEntry}`} className="finderColumn">
                        <div className="finderColumnHeader">
                          <strong>{pathEntry === "." ? "Root" : pathEntry.split("/").pop()}</strong>
                        </div>
                        <ul className="finderList">
                          {(volumeFileCaches[pane.volume.id]?.[pathEntry] ?? [])
                            .filter((file) => !shouldHideSourceEntry(file))
                            .map((file) => {
                            const nextPath = file.relativePath;
                            const selected = (selectedByVolume[pane.volume.id] ?? []).includes(file.relativePath);
                            const isActive = pane.path === nextPath;
                            const isPreviewed =
                              sourcePreview?.volumeId === pane.volume.id &&
                              sourcePreview.relativePath === file.relativePath;
                            return (
                              <li
                                key={`${pane.volume.id}:${pathEntry}:${file.relativePath}`}
                                className={`finderItem ${isActive ? "finderItemActive" : ""} ${isPreviewed ? "finderItemPreviewed" : ""}`}
                              >
                                <button
                                  className="finderOpen"
                                  onClick={() => {
                                    if (file.kind === "directory") {
                                      navigateVolume(pane.volume.id, nextPath);
                                      return;
                                    }
                                    setSourcePreview({
                                      volumeId: pane.volume.id,
                                      volumeName: pane.volume.name,
                                      relativePath: file.relativePath,
                                      size: file.size,
                                      modifiedAt: file.modifiedAt,
                                      kind: file.kind,
                                      previewable: canPreviewFile(file)
                                    });
                                    toggleSelectedSource(pane.volume.id, file.relativePath, !selected);
                                  }}
                                >
                                  <span>{file.relativePath.split("/").pop() ?? file.relativePath}</span>
                                  <small>{file.kind === "directory" ? "folder" : formatFileSize(file.size)}</small>
                                </button>
                                {file.kind === "directory" ? (
                                  <div className="rowActions">
                                    <button
                                      type="button"
                                      className="sourceFavoriteInlineButton"
                                      onClick={() => toggleSourceFavorite(pane.volume.id, pane.volume.name, file.relativePath)}
                                    >
                                      {sourceFavorites.some(
                                        (favorite) => favorite.volumeId === pane.volume.id && favorite.path === file.relativePath
                                      )
                                        ? "Unfavorite"
                                        : "Favorite"}
                                    </button>
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
              </div>
            </div>
            <aside className="thumbnailPanel">
              <div className="sectionTitleRow">
                <h3>Inspector</h3>
                <span className="infoHint" data-tooltip="Previewed media fills the panel, while file details stay pinned so they remain visible as you scroll.">
                  ?
                </span>
              </div>
              {sourcePreview ? (
                <div className="thumbnailViewer">
                  {sourcePreview.previewable ? (
                    <img
                      className="thumbnailImage"
                      src={`${apiBase}/volumes/${sourcePreview.volumeId}/thumbnail?path=${encodeURIComponent(sourcePreview.relativePath)}&size=640`}
                      alt={sourcePreview.relativePath}
                    />
                  ) : (
                    <div className="thumbnailFallback">
                      <strong>No preview available</strong>
                      <span>This file type can still be selected and added to the pool.</span>
                    </div>
                  )}
                  <div className="inspectorInfo">
                    <div className="inspectorMeta">
                      <strong>{sourcePreview.relativePath.split("/").pop() ?? sourcePreview.relativePath}</strong>
                      <span>{sourcePreview.volumeName}</span>
                      <small>{sourcePreview.relativePath}</small>
                    </div>
                    <dl className="inspectorDetails">
                      <div>
                        <dt>Type</dt>
                        <dd>{sourcePreview.kind}</dd>
                      </div>
                      <div>
                        <dt>Size</dt>
                        <dd>{formatFileSize(sourcePreview.size)}</dd>
                      </div>
                      <div>
                        <dt>Modified</dt>
                        <dd>{new Date(sourcePreview.modifiedAt).toLocaleString()}</dd>
                      </div>
                      {sourceMetadataLoading ? (
                        <div>
                          <dt>Metadata</dt>
                          <dd>Reading EXIF and clip metadata...</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.cameraMake || sourceMetadata?.cameraModel ? (
                        <div>
                          <dt>Camera</dt>
                          <dd>{[sourceMetadata.cameraMake, sourceMetadata.cameraModel].filter(Boolean).join(" ")}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.lensModel ? (
                        <div>
                          <dt>Lens</dt>
                          <dd>{sourceMetadata.lensModel}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.reelName ? (
                        <div>
                          <dt>Reel</dt>
                          <dd>{sourceMetadata.reelName}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.timecode ? (
                        <div>
                          <dt>Timecode</dt>
                          <dd>{sourceMetadata.timecode}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.resolution ? (
                        <div>
                          <dt>Resolution</dt>
                          <dd>{sourceMetadata.resolution}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.frameRate != null ? (
                        <div>
                          <dt>Frame Rate</dt>
                          <dd>{formatFrameRate(sourceMetadata?.frameRate ?? null)}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.durationSeconds != null ? (
                        <div>
                          <dt>Duration</dt>
                          <dd>{formatDuration(sourceMetadata?.durationSeconds ?? null)}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.videoCodec ? (
                        <div>
                          <dt>Video</dt>
                          <dd>{sourceMetadata.videoCodec}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.audioCodec ? (
                        <div>
                          <dt>Audio</dt>
                          <dd>
                            {[
                              sourceMetadata.audioCodec,
                              sourceMetadata.audioChannels ? `${sourceMetadata.audioChannels} ch` : null,
                              sourceMetadata.sampleRate ? `${sourceMetadata.sampleRate} Hz` : null
                            ].filter(Boolean).join(" • ")}
                          </dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.colorSpace || sourceMetadata?.gamma ? (
                        <div>
                          <dt>Color</dt>
                          <dd>{[sourceMetadata.colorSpace, sourceMetadata.gamma].filter(Boolean).join(" • ")}</dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.cameraSerialNumber || sourceMetadata?.firmwareVersion || sourceMetadata?.focalLength ? (
                        <div>
                          <dt>Camera Info</dt>
                          <dd>
                            {[
                              sourceMetadata.cameraSerialNumber ? `Serial ${sourceMetadata.cameraSerialNumber}` : null,
                              sourceMetadata.firmwareVersion ? `FW ${sourceMetadata.firmwareVersion}` : null,
                              sourceMetadata.focalLength ? `Focal ${sourceMetadata.focalLength}` : null
                            ].filter(Boolean).join(" • ")}
                          </dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.scene || sourceMetadata?.take ? (
                        <div>
                          <dt>Slate</dt>
                          <dd>
                            {[
                              sourceMetadata.scene ? `Scene ${sourceMetadata.scene}` : null,
                              sourceMetadata.take ? `Take ${sourceMetadata.take}` : null
                            ].filter(Boolean).join(" • ")}
                          </dd>
                        </div>
                      ) : null}
                      {sourceMetadata?.iso || sourceMetadata?.whiteBalance || sourceMetadata?.shutterSpeed || sourceMetadata?.aperture ? (
                        <div>
                          <dt>Exposure</dt>
                          <dd>
                            {[
                              sourceMetadata.iso ? `ISO ${sourceMetadata.iso}` : null,
                              sourceMetadata.whiteBalance ? `WB ${sourceMetadata.whiteBalance}` : null,
                              sourceMetadata.shutterSpeed ? `Shutter ${sourceMetadata.shutterSpeed}` : null,
                              sourceMetadata.aperture ? `Aperture ${sourceMetadata.aperture}` : null
                            ].filter(Boolean).join(" • ")}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </div>
                </div>
              ) : (
                <div className="muted">Select an image or video file to inspect it.</div>
              )}
            </aside>
          </div>
        </article>
      </section>

      <section className="workflowSection workflowSectionSplit">
        <article className="panel fixedPanel">
          <div className="sectionTitleRow">
            <h2>Selected Source Pool</h2>
            <span className="infoHint" data-tooltip="Each pooled source item can be retargeted with the folder dropdown or removed before starting the ingest.">
              ?
            </span>
          </div>
          <div className="sourcePool">
            {pooledSources.length > 0 ? (
              pooledSources.map((source) => (
                <div
                  key={sourceKey(source.volumeId, source.sourcePath)}
                  className={`sourcePoolItem ${draggedSourceKey === sourceKey(source.volumeId, source.sourcePath) ? "sourcePoolItemDragging" : ""}`}
                  draggable
                  onDragStart={(event) => {
                    const payload = JSON.stringify({ volumeId: source.volumeId, sourcePath: source.sourcePath });
                    event.dataTransfer.setData("application/json", payload);
                    event.dataTransfer.effectAllowed = "move";
                    setDraggedSourceKey(sourceKey(source.volumeId, source.sourcePath));
                  }}
                  onDragEnd={() => setDraggedSourceKey(null)}
                >
                  <strong>{source.sourcePath.split("/").pop() ?? source.sourcePath}</strong>
                  <span>{source.volumeName}</span>
                  <small>Source: {source.sourcePath}</small>
                  <label className="targetPicker">
                    <span>Target Folder</span>
                    <select
                      value={source.targetPath}
                      onChange={(event) =>
                        ingestMode === "auto"
                          ? assignTargetToVolume(source.volumeId, event.target.value)
                          : assignTargetToSource(source.volumeId, source.sourcePath, event.target.value)
                      }
                    >
                      {projectDirectories.map((directory) => (
                        <option key={`${sourceKey(source.volumeId, source.sourcePath)}:${directory}`} value={directory}>
                          {directory === "." ? "Project Root" : directory}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="pickerActions">
                    {ingestMode === "auto" ? (
                      <button
                        type="button"
                        onClick={() =>
                          openRenameDialog({
                            kind: "auto",
                            volumeId: source.volumeId,
                            currentPath: source.targetPath,
                            currentName: source.targetPath.split("/").pop() ?? source.targetPath
                          })
                        }
                      >
                        Rename Folder
                      </button>
                    ) : null}
                    <button className="dangerButton" onClick={() => removePooledSource(source.volumeId, source.sourcePath)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="muted">Selections will appear here after you tick files or folders in the source browser.</div>
            )}
          </div>
        </article>

        <article className="panel fixedPanel">
          <div className="sectionTitleRow">
            <h2>Project Folder Structure</h2>
            <span className="infoHint" data-tooltip="Use this view to browse the folder tree, create folders, or drag pooled items directly onto target directories.">
              ?
            </span>
          </div>
          <div className="stack">
            <div className="pickerActions">
              <button type="button" disabled>
                Project
              </button>
              <button
                onClick={() => {
                  const nextPath = managedPath === "." ? "." : managedPath.split("/").slice(0, -1).join("/") || ".";
                  setManagedPath(nextPath);
                }}
                disabled={managedPath === "."}
              >
                Up
              </button>
              <button onClick={() => setManagedPath(".")}>Root</button>
            </div>
            <div className="destinationRow">
              <strong>Create Folder</strong>
              <input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="New folder name" />
              <div className="pickerActions">
                <button onClick={createManagedFolder} disabled={!selectedProjectId || !newFolderName.trim() || managedRoot !== "project"}>
                  Add Folder
                </button>
              </div>
            </div>
            <div className="finderColumns">
              {managedPathChain.map((pathEntry) => (
                <div key={`${managedRoot}:${pathEntry}`} className="finderColumn">
                  <div className="finderColumnHeader">
                    <strong>{pathEntry === "." ? "Root" : pathEntry.split("/").pop()}</strong>
                  </div>
                  <ul className="finderList">
                    {(managedFileCache[pathEntry] ?? []).map((entry) => {
                      const isActive = managedPath === entry.relativePath;
                      return (
                        <li
                          key={`${managedRoot}:${pathEntry}:${entry.relativePath}`}
                          className={`finderItem ${isActive ? "finderItemActive" : ""}`}
                        >
                          <button
                            className="finderOpen"
                            onClick={() => {
                              if (entry.kind === "directory") {
                                setManagedPath(entry.relativePath);
                              }
                            }}
                            onDragOver={(event) => {
                              if (managedRoot === "project" && entry.kind === "directory") {
                                event.preventDefault();
                              }
                            }}
                            onDrop={(event) => {
                              if (managedRoot !== "project" || entry.kind !== "directory") {
                                return;
                              }
                              event.preventDefault();
                              const payload = event.dataTransfer.getData("application/json");
                              if (!payload) {
                                return;
                              }
                              const parsed = JSON.parse(payload) as { volumeId: string; sourcePath: string };
                              assignTargetToSource(parsed.volumeId, parsed.sourcePath, entry.relativePath);
                              setDraggedSourceKey(null);
                            }}
                          >
                            <span>{entry.relativePath.split("/").pop() ?? entry.relativePath}</span>
                            <small>{entry.kind === "directory" ? "folder" : `${entry.size} bytes`}</small>
                          </button>
                          {entry.kind === "directory" ? (
                            <div className="rowActions">
                              <button
                                disabled={managedRoot !== "project"}
                                onClick={() =>
                                  openRenameDialog({
                                    kind: "managed",
                                    relativePath: entry.relativePath,
                                    currentName: entry.relativePath.split("/").pop() ?? entry.relativePath
                                  })
                                }
                              >
                                Rename Folder
                              </button>
                            </div>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </article>
      </section>

      <section className="workflowSection">
        <article className="panel fixedPanel">
          <div className="sectionTitleRow">
            <h2>Copy Destinations</h2>
            <span className="infoHint" data-tooltip="Project and Destination A are always active. Enable extra copies here and choose their target folders.">
              ?
            </span>
          </div>
          {draftDestinations ? (
            <div className="stack">
              <div className="destinationRow">
                <strong>Project Root</strong>
                <code>{draftDestinations.projectRoot}</code>
                <div className="pickerActions">
                  <button onClick={() => openDestinationPicker("projectRoot")}>Choose Folder</button>
                </div>
              </div>
              <div className="destinationRow">
                <strong>Destination A</strong>
                <code>{draftDestinations.destinationA}</code>
                <div className="pickerActions">
                  <button onClick={() => openDestinationPicker("destinationA")}>Choose Folder</button>
                </div>
              </div>
              <div className="destinationRow">
                <label className="checkRow">
                  <input
                    type="checkbox"
                    checked={draftDestinations.destinationBEnabled}
                    onChange={(event) =>
                      void persistDestinations({
                        ...draftDestinations,
                        destinationBEnabled: event.target.checked
                      })
                    }
                  />
                  <span>Enable Third Copy</span>
                  <small>Add another verified destination.</small>
                </label>
                {draftDestinations.destinationBEnabled ? (
                  <>
                    <code>{draftDestinations.destinationB}</code>
                    <div className="pickerActions">
                      <button onClick={() => openDestinationPicker("destinationB")}>Choose Folder</button>
                    </div>
                  </>
                ) : null}
              </div>
              <div className="destinationRow">
                <label className="checkRow">
                  <input
                    type="checkbox"
                    checked={draftDestinations.destinationCEnabled}
                    onChange={(event) =>
                      void persistDestinations({
                        ...draftDestinations,
                        destinationCEnabled: event.target.checked
                      })
                    }
                  />
                  <span>Enable Fourth Copy</span>
                  <small>Add one more verified destination.</small>
                </label>
                {draftDestinations.destinationCEnabled ? (
                  <>
                    <code>{draftDestinations.destinationC}</code>
                    <div className="pickerActions">
                      <button onClick={() => openDestinationPicker("destinationC")}>Choose Folder</button>
                    </div>
                  </>
                ) : null}
              </div>
              <div className="muted">Project and Dest A are always active. Changes here save immediately.</div>
            </div>
          ) : (
            <div className="muted">Loading configured destination roots.</div>
          )}
        </article>
      </section>

      <section className="ingestSection">
        <button className="startIngestButton" onClick={startJob} disabled={!canStart}>
          Start Ingest
        </button>
        <button className="jobsToggleButton" onClick={() => setShowJobsPopup((current) => !current)}>
          {showJobsPopup ? "Hide Jobs" : `Jobs (${jobs.length})`}
        </button>
        <button className="jobsToggleButton" onClick={() => setShowSettings(true)}>
          Settings
        </button>
      </section>

      {showSettings ? (
        <aside className="pickerModal">
          <div className="pickerModalCard settingsModalCard">
            <div className="jobsPopupHeader">
              <h2>Settings</h2>
              <button onClick={() => setShowSettings(false)}>Close</button>
            </div>
            <div className="stack">
              <div className="destinationRow">
                <strong>Signed In As</strong>
                <span>{authStatus.username}</span>
              </div>
              <div className="destinationRow">
                <strong>Theme</strong>
                <select value={theme} onChange={(event) => setTheme(event.target.value as "dark" | "light")}>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </div>
              <div className="destinationRow">
                <strong>Instance Name</strong>
                <input
                  value={instanceNameDraft}
                  onChange={(event) => setInstanceNameDraft(event.target.value)}
                  placeholder="Edit suite, cart, machine name..."
                />
                <div className="pickerActions">
                  <button
                    type="button"
                    onClick={() => void persistAppSettings({ instanceName: instanceNameDraft })}
                    disabled={instanceNameDraft.trim() === appSettings.instanceName.trim()}
                  >
                    Save Name
                  </button>
                </div>
              </div>
              <div className="destinationRow">
                <strong>Metadata Parsing</strong>
                <label className={`authCheckbox ${appSettings.advancedMetadataEnabled ? "authCheckboxSelected" : ""}`}>
                  <input
                    type="checkbox"
                    checked={appSettings.advancedMetadataEnabled}
                    onChange={(event) => void persistAppSettings({ advancedMetadataEnabled: event.target.checked })}
                  />
                  <span>Enable advanced camera metadata fields</span>
                </label>
              </div>
              <div className="destinationRow">
                <strong>Detailed Logs</strong>
                <div className="pickerActions">
                  <button
                    type="button"
                    onClick={() => {
                      setShowSettings(false);
                      setShowLogsPopup(true);
                    }}
                  >
                    Open Logs
                  </button>
                </div>
              </div>
              {updateStatus.state === "available" ? (
                <div className="destinationRow">
                  <strong>Update Available</strong>
                  <span>A newer Wrangler build is on GitHub ({updateStatus.latestSha}).</span>
                  <small className="muted">Run `git pull` from your Wrangler directory, then launch again.</small>
                </div>
              ) : null}
              <div className="destinationRow">
                <div className="sectionTitleRow">
                  <strong>Stop Wrangler</strong>
                  <span
                    className="infoHint"
                    data-tooltip="This only stops Wrangler services by bringing the Docker stack down and exiting the helper. It does not shut down the computer."
                  >
                    ?
                  </span>
                </div>
                <div className="pickerActions">
                  <button
                    type="button"
                    className="dangerButton"
                    onClick={() =>
                      setConfirmDialog({
                        kind: "shutdown",
                        title: "Stop Wrangler",
                        message: "Stop Wrangler services for this instance by bringing the Docker stack down and closing the helper?",
                        confirmLabel: "Stop Wrangler"
                      })
                    }
                  >
                    Stop Wrangler
                  </button>
                </div>
              </div>
              <div className="destinationRow">
                <strong>Reset To Defaults</strong>
                <div className="authField">
                  <label htmlFor="reset-password-input">Confirm Password</label>
                  <input
                    id="reset-password-input"
                    type="password"
                    value={resetPassword}
                    onChange={(event) => setResetPassword(event.target.value)}
                    placeholder="Enter your password to reset setup"
                  />
                </div>
                <div className="pickerActions">
                  <button
                    type="button"
                    className="dangerButton"
                    onClick={() => void resetDestinations()}
                    disabled={!resetPassword.trim()}
                  >
                    Reset To Defaults
                  </button>
                </div>
              </div>
              <div className="pickerActions">
                <button type="button" className="dangerButton" onClick={() => void logout()}>
                  Log Out
                </button>
              </div>
            </div>
          </div>
        </aside>
      ) : null}

      {renameDialog ? (
        <aside className="pickerModal">
          <div className="pickerModalCard renameModalCard">
            <div className="jobsPopupHeader">
              <h2>Rename Folder</h2>
              <button onClick={closeRenameDialog}>Close</button>
            </div>
            <div className="stack">
              <div className="destinationRow">
                <strong>Current</strong>
                <code>{renameDialog.currentName}</code>
              </div>
              <div className="authField">
                <label htmlFor="rename-folder-input">New Folder Name</label>
                <input
                  id="rename-folder-input"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  placeholder="Folder name"
                  autoFocus
                />
              </div>
              <div className="pickerActions">
                <button onClick={closeRenameDialog}>Cancel</button>
                <button onClick={() => void submitRenameDialog()} disabled={!renameValue.trim()}>
                  Save Rename
                </button>
              </div>
            </div>
          </div>
        </aside>
      ) : null}

      {confirmDialog ? (
        <aside className="pickerModal">
          <div className="pickerModalCard renameModalCard">
            <div className="jobsPopupHeader">
              <h2>{confirmDialog.title}</h2>
              <button onClick={() => setConfirmDialog(null)}>Close</button>
            </div>
            <div className="stack">
              <p className="muted">{confirmDialog.message}</p>
              <div className="pickerActions">
                <button onClick={() => setConfirmDialog(null)}>Cancel</button>
                <button className="dangerButton" onClick={() => void submitConfirmDialog()}>
                  {confirmDialog.confirmLabel}
                </button>
              </div>
            </div>
          </div>
        </aside>
      ) : null}

      {showJobsPopup ? (
        <aside className="jobsPopup">
          <div className="jobsPopupHeader">
            <h2>Transfers</h2>
            <button onClick={() => setShowJobsPopup(false)}>Close</button>
          </div>
          <ul className="jobList">
            {jobs.map((job) => (
              <li key={job.id}>
                <div className="jobRow">
                  <button
                    className={`jobButton ${jobDetails?.job.id === job.id ? "jobButtonSelected" : ""}`}
                    onClick={() => void inspectJob(job.id)}
                  >
                    <div className="jobButtonMain">
                      <div className="jobButtonHeader">
                        <strong>{job.status}</strong>
                        <span>{job.summary ?? job.id}</span>
                      </div>
                      <div className="jobProgress">
                        <div className="jobProgressTrack" aria-hidden="true">
                          <div
                            className="jobProgressFill"
                            style={{ width: `${jobProgressPercent(job.status, job.summary)}%` }}
                          />
                        </div>
                        <small>{jobProgressPercent(job.status, job.summary)}%</small>
                      </div>
                    </div>
                  </button>
                  <button className="jobLogsButton" onClick={() => void inspectJob(job.id, { openLogs: true })}>
                    Logs
                  </button>
                  {["queued", "scanning", "copyingToProject", "hashingProject", "copyingToDestinations", "verifyingDestinations"].includes(
                    job.status
                  ) ? (
                    <button className="jobLogsButton" onClick={() => void cancelJob(job.id)}>
                      Cancel
                    </button>
                  ) : null}
                  <button className="jobRemoveButton" onClick={() => removeJob(job.id)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </aside>
      ) : null}

      {showLogsPopup ? (
        <aside className="jobsPopup logsPopup">
          <div className="jobsPopupHeader">
            <h2>Logs</h2>
            <button onClick={() => setShowLogsPopup(false)}>Close</button>
          </div>
          {jobDetails ? (
            <div className="stack">
              <div className="logSummaryGrid">
                <div className="destinationRow">
                  <strong>Status</strong>
                  <span>{jobDetails.job.status}</span>
                </div>
                <div className="destinationRow">
                  <strong>Project</strong>
                  <span>{jobDetails.project?.name ?? "Unknown"}</span>
                </div>
                <div className="destinationRow">
                  <strong>Checksummed Files</strong>
                  <span>{jobDetails.copies.length}</span>
                </div>
              </div>
              <ul className="eventList">
                {jobDetails.events.map((event) => (
                  <li key={event.id} className="logEventItem">
                    <strong>{event.stage}</strong>
                    <span>{event.message}</span>
                    <small>{new Date(event.createdAt).toLocaleString()}</small>
                  </li>
                ))}
              </ul>
              <div className="checksumSection">
                <strong>Checksums</strong>
                {jobDetails.copies.length > 0 ? (
                  <ul className="checksumList">
                    {jobDetails.copies.map((copy) => (
                      <li key={copy.id} className="checksumItem">
                        <span>{copy.destinationKind}: {copy.relativePath}</span>
                        <code>{copy.checksum ?? "pending"}</code>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="muted">No checksum records yet.</div>
                )}
              </div>
            </div>
          ) : (
            <div className="muted">Open logs from any transfer to inspect detailed events here.</div>
          )}
        </aside>
      ) : null}

      {showDestinationPicker ? (
        <aside className="pickerModal">
          <div className="pickerModalCard">
            <div className="jobsPopupHeader">
              <h2>Choose Destination Folder</h2>
              <button
                onClick={() => {
                  setShowDestinationPicker(false);
                  setDestinationPickerField(null);
                }}
              >
                Close
              </button>
            </div>
            <div className="stack">
              <div className="destinationRow">
                <strong>Current Path</strong>
                <code>{macDirectoryPath}</code>
                <div className="pickerActions">
                  <button
                    onClick={() => navigateDestinationPicker(
                      macDirectoryHistory[macDirectoryHistoryIndex + 1] ?? macDirectoryPath
                    )}
                    disabled={macDirectoryHistoryIndex >= macDirectoryHistory.length - 1}
                  >
                    Forward
                  </button>
                  <button
                    onClick={() =>
                      navigateDestinationPicker(
                        macDirectoryPath === "/Users" || macDirectoryPath === "/Volumes"
                          ? macDirectoryPath
                          : macDirectoryPath.split("/").slice(0, -1).join("/") || "/Users"
                      )
                    }
                    disabled={macDirectoryPath === "/Users" || macDirectoryPath === "/Volumes"}
                  >
                    Back
                  </button>
                </div>
              </div>
              {destinationPresets.length > 0 ? (
                <div className="destinationPresetRow">
                  {destinationPresets.map((preset) => (
                    <button key={preset.path} type="button" className="destinationPresetButton" onClick={() => navigateDestinationPicker(preset.path)}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <ul className="fileList">
                {macDirectories.map((directory) => (
                  <li key={directory.path}>
                    <button className="jobButton" onClick={() => navigateDestinationPicker(directory.path)}>
                      <span>{directory.name}</span>
                      <small>{directory.path}</small>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="pickerActions">
                <button onClick={() => applyPickedDestination(macDirectoryPath)}>Use This Folder</button>
              </div>
            </div>
          </div>
        </aside>
      ) : null}

      {draftDestinations && !destinationsConfigured && !showDestinationPicker ? (
        <aside className="pickerModal">
          <div className="pickerModalCard setupModalCard">
            <div className="jobsPopupHeader">
              <h2>Finish Setup</h2>
            </div>
            <div className="stack">
              <p className="muted">
                This machine needs its own destination folders before Wrangler can create projects or write files.
              </p>
              <div className="sectionTitleRow">
                <strong>Startup</strong>
                <span
                  className="infoHint"
                  data-tooltip="Use npm run launch from the project root to start the host helper and Docker stack together in the background. After that you can close the terminal. You can later stop only Wrangler services from Settings."
                >
                  ?
                </span>
              </div>
              <code>npm run launch</code>
              <div className="setupSteps">
                <div className="destinationRow">
                  <strong>Instance Name</strong>
                  <input
                    value={setupInstanceName}
                    onChange={(event) => setSetupInstanceName(event.target.value)}
                    placeholder="DIT Cart A, Studio B, Ingest 01..."
                  />
                  <div className="pickerActions">
                    <button
                      type="button"
                      onClick={() => void saveSetupInstanceName()}
                      disabled={setupInstanceName.trim() === appSettings.instanceName.trim()}
                    >
                      Save Name
                    </button>
                  </div>
                  <small className="muted">Used in the browser tab title so multiple Wrangler windows are easy to tell apart.</small>
                </div>
                <div className="destinationRow">
                  <strong>1. Choose Project Root</strong>
                  <code>{draftDestinations.projectRoot}</code>
                  <small className="muted">
                    {isHostDestinationPath(draftDestinations.projectRoot) ? "Ready" : "Choose a folder in /Users or /Volumes."}
                  </small>
                  <div className="pickerActions">
                    <button onClick={() => openDestinationPicker("projectRoot")}>Choose Folder</button>
                  </div>
                </div>
                <div className="destinationRow">
                  <strong>2. Choose Destination A</strong>
                  <code>{draftDestinations.destinationA}</code>
                  <small className="muted">
                    {isHostDestinationPath(draftDestinations.destinationA) ? "Ready" : "Choose a folder in /Users or /Volumes."}
                  </small>
                  <div className="pickerActions">
                    <button onClick={() => openDestinationPicker("destinationA")}>Choose Folder</button>
                  </div>
                </div>
              </div>
              <p className="muted">
                Optional third and fourth copies can be enabled later from the Copy Destinations panel.
              </p>
              <div className="pickerActions">
                <button
                  type="button"
                  className="startIngestButton"
                  onClick={() => void finishSetup()}
                  disabled={
                    !isHostDestinationPath(draftDestinations.projectRoot) ||
                    !isHostDestinationPath(draftDestinations.destinationA)
                  }
                >
                  Finish Setup
                </button>
              </div>
            </div>
          </div>
        </aside>
      ) : null}

      {error ? (
        <button type="button" className="errorToast" onClick={() => setError(null)} aria-label="Dismiss error">
          <span className="errorToastLabel">Error</span>
          <span>{error}</span>
          <span className="errorToastHint">Click to dismiss</span>
        </button>
      ) : null}

      <footer className="appFooter">
        <div className="appFooterCopy">
          <small>Copyright © 2026 Wrangler. Intended for open-source release.</small>
          <small>Brand styling and associated marks shown here for attribution/reference.</small>
          <div className="appFooterActions">
          </div>
        </div>
        <img className="footerBrandMark" src={raconteurLogo} alt="Raconteur" />
      </footer>
    </main>
  );
}
