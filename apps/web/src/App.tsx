import { useEffect, useMemo, useState } from "react";
import type { BrowserRoot, FileEntry, Job, Project, SelectedSourceItem, Volume } from "@wrangler/shared";
import wranglerLogo from "./assets/wrangler-logo-alpha.png";
import raconteurLogo from "./assets/raconteur-logo-alpha.png";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "/api";

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
  return name === ".ds_store" || name.startsWith("._");
}

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
  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [showSettings, setShowSettings] = useState(false);
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
  const [macDirectories, setMacDirectories] = useState<MacDirectoryEntry[]>([]);
  const [destinationPresets, setDestinationPresets] = useState<DestinationPreset[]>([]);
  const [managedRoot, setManagedRoot] = useState<BrowserRoot>("project");
  const [managedPath, setManagedPath] = useState(".");
  const [managedFileCache, setManagedFileCache] = useState<Record<string, FileEntry[]>>({});
  const [projectDirectories, setProjectDirectories] = useState<string[]>(["."]);
  const [newFolderName, setNewFolderName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [showJobsPopup, setShowJobsPopup] = useState(false);
  const [showLogsPopup, setShowLogsPopup] = useState(false);
  const [draggedSourceKey, setDraggedSourceKey] = useState<string | null>(null);
  const [sourcePreview, setSourcePreview] = useState<SourcePreview | null>(null);
  const [sourceFavorites, setSourceFavorites] = useState<SourceFavorite[]>([]);

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
      const [nextVolumes, nextProjects, nextJobs, nextDestinations] = await Promise.all([
        requestJson<Volume[]>("/volumes"),
        requestJson<Project[]>("/projects"),
        requestJson<Job[]>("/jobs"),
        requestJson<DestinationSettingsResponse>("/destinations")
      ]);

      setVolumes(nextVolumes);
      setProjects(nextProjects);
      setJobs(nextJobs);
      setDestinations(nextDestinations);
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

  async function clearProjects() {
    const confirmed = window.confirm("Clear all projects and related job history? This will remove project records and project folders.");
    if (!confirmed) {
      return;
    }

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
    const confirmed = window.confirm("Reset destination setup for this machine and return to the first-run prompt?");
    if (!confirmed) {
      return;
    }

    try {
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
    setShowDestinationPicker(true);
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
    if (!selectedProjectId || !newFolderName.trim()) {
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

  async function deleteManagedFolder(relativePath: string) {
    if (!selectedProjectId) {
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
        selectedVolumeIds.some((volumeId) => (selectedByVolume[volumeId] ?? []).length > 0)
      ),
    [destinationsConfigured, selectedByVolume, selectedProjectId, selectedVolumeIds]
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
            <div className="pickerActions">
              <button onClick={createProject} disabled={!projectName.trim() || !destinationsConfigured}>
                Create Project
              </button>
              <button className="dangerButton" onClick={clearProjects} disabled={projects.length === 0}>
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
        <article className="panel fixedPanel sourceBrowserPanel">
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
                <article key={pane.volume.id} className="subPanel">
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
                  <div className="finderColumns">
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
                      onChange={(event) => assignTargetToSource(source.volumeId, source.sourcePath, event.target.value)}
                    >
                      {projectDirectories.map((directory) => (
                        <option key={`${sourceKey(source.volumeId, source.sourcePath)}:${directory}`} value={directory}>
                          {directory === "." ? "Project Root" : directory}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="pickerActions">
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
              <select value={managedRoot} onChange={(event) => setManagedRoot(event.target.value as BrowserRoot)}>
                {availableManagedRoots.map((root) => (
                  <option key={root.value} value={root.value}>
                    {root.label}
                  </option>
                ))}
              </select>
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
                <button onClick={createManagedFolder} disabled={!selectedProjectId || !newFolderName.trim()}>
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
                              <button className="dangerButton" onClick={() => deleteManagedFolder(entry.relativePath)}>
                                Delete Folder
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
              <div className="pickerActions">
                <button type="button" className="dangerButton" onClick={() => void logout()}>
                  Log Out
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
                  <button onClick={() => setMacDirectoryPath("/Users")}>Users</button>
                  <button onClick={() => setMacDirectoryPath("/Volumes")}>Volumes</button>
                  <button
                    onClick={() =>
                      setMacDirectoryPath(
                        macDirectoryPath === "/Users" || macDirectoryPath === "/Volumes"
                          ? macDirectoryPath
                          : macDirectoryPath.split("/").slice(0, -1).join("/") || "/Users"
                      )
                    }
                    disabled={macDirectoryPath === "/Users" || macDirectoryPath === "/Volumes"}
                  >
                    Up
                  </button>
                  <button onClick={() => applyPickedDestination(macDirectoryPath)}>Use This Folder</button>
                </div>
              </div>
              {destinationPresets.length > 0 ? (
                <div className="destinationPresetRow">
                  {destinationPresets.map((preset) => (
                    <button key={preset.path} type="button" className="destinationPresetButton" onClick={() => setMacDirectoryPath(preset.path)}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <ul className="fileList">
                {macDirectories.map((directory) => (
                  <li key={directory.path}>
                    <button className="jobButton" onClick={() => setMacDirectoryPath(directory.path)}>
                      <span>{directory.name}</span>
                      <small>{directory.path}</small>
                    </button>
                  </li>
                ))}
              </ul>
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
              <div className="setupSteps">
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
            <button type="button" className="footerResetButton" onClick={resetDestinations}>
              Reset To Defaults
            </button>
          </div>
        </div>
        <img className="footerBrandMark" src={raconteurLogo} alt="Raconteur" />
      </footer>
    </main>
  );
}
