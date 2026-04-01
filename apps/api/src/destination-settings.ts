import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

export type DestinationSettings = {
  projectRoot: string;
  destinationA: string;
  destinationB: string;
  destinationBEnabled: boolean;
  destinationC: string;
  destinationCEnabled: boolean;
};

type DestinationPreset = {
  label: string;
  path: string;
};

const destinationRoots = [config.macDestinationRoot, config.sourceRoot]
  .map((root) => path.resolve(root))
  .filter((root, index, values) => values.indexOf(root) === index);

const settingsPath = path.join(config.appDataRoot, "destination-settings.json");

function buildDefaultSettings(): DestinationSettings {
  return {
    projectRoot: config.projectsRoot,
    destinationA: config.destARoot,
    destinationB: config.destBRoot,
    destinationBEnabled: false,
    destinationC: config.destCRoot,
    destinationCEnabled: false
  };
}

export function hasSavedDestinationSettings(): boolean {
  return fs.existsSync(settingsPath);
}

export function getDestinationSettings(): DestinationSettings {
  if (!fs.existsSync(settingsPath)) {
    return buildDefaultSettings();
  }

  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Partial<DestinationSettings>;
  return {
    projectRoot: parsed.projectRoot ?? config.projectsRoot,
    destinationA: parsed.destinationA ?? config.destARoot,
    destinationB: parsed.destinationB ?? config.destBRoot,
    destinationBEnabled: parsed.destinationBEnabled ?? false,
    destinationC: parsed.destinationC ?? config.destCRoot,
    destinationCEnabled: parsed.destinationCEnabled ?? false
  };
}

export async function saveDestinationSettings(input: DestinationSettings): Promise<DestinationSettings> {
  const normalized = {
    projectRoot: normalizeDestinationPath(input.projectRoot),
    destinationA: normalizeDestinationPath(input.destinationA),
    destinationB: input.destinationBEnabled ? normalizeDestinationPath(input.destinationB) : buildDefaultSettings().destinationB,
    destinationBEnabled: Boolean(input.destinationBEnabled),
    destinationC: input.destinationCEnabled ? normalizeDestinationPath(input.destinationC) : buildDefaultSettings().destinationC,
    destinationCEnabled: Boolean(input.destinationCEnabled)
  };

  const destinationsToEnsure = [
    normalized.projectRoot,
    normalized.destinationA,
    normalized.destinationBEnabled ? normalized.destinationB : null,
    normalized.destinationCEnabled ? normalized.destinationC : null
  ].filter((destination): destination is string => Boolean(destination));

  for (const destination of destinationsToEnsure) {
    await fsp.mkdir(destination, { recursive: true });
  }

  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

export async function resetDestinationSettings(): Promise<void> {
  await fsp.rm(settingsPath, { force: true });
}

export async function listMacDirectories(relativePath = "."): Promise<{
  currentPath: string;
  directories: Array<{ name: string; path: string }>;
  presets: DestinationPreset[];
}> {
  const directory = resolveDestinationDirectory(relativePath);
  const entries = await fsp.readdir(directory, { withFileTypes: true });

  return {
    currentPath: directory,
    directories: entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => ({
        name: entry.name,
        path: path.join(directory, entry.name)
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    presets: await buildDestinationPresets()
  };
}

function normalizeDestinationPath(input: string): string {
  return resolveDestinationDirectory(input);
}

function resolveDestinationDirectory(input: string): string {
  const candidate = input === "." ? config.macDestinationRoot : input;
  const resolvedCandidate = path.resolve(candidate);
  for (const root of destinationRoots) {
    if (resolvedCandidate === root || resolvedCandidate.startsWith(`${root}${path.sep}`)) {
      return resolvedCandidate;
    }
  }

  throw new Error(`Path escapes allowed destinations: ${input}`);
}

async function buildDestinationPresets(): Promise<DestinationPreset[]> {
  const homeDirectory = os.homedir();
  const candidatePresets: DestinationPreset[] = [
    { label: "Users", path: config.macDestinationRoot },
    { label: "Home", path: homeDirectory },
    { label: "Desktop", path: path.join(homeDirectory, "Desktop") },
    { label: "Documents", path: path.join(homeDirectory, "Documents") },
    { label: "Downloads", path: path.join(homeDirectory, "Downloads") },
    { label: "CloudStorage", path: path.join(homeDirectory, "Library", "CloudStorage") },
    { label: "Volumes", path: config.sourceRoot }
  ];

  const availablePresets = await Promise.all(
    candidatePresets.map(async (preset) => {
      try {
        const resolvedPath = resolveDestinationDirectory(preset.path);
        const stats = await fsp.stat(resolvedPath);
        return stats.isDirectory() ? { label: preset.label, path: resolvedPath } : null;
      } catch {
        return null;
      }
    })
  );

  return availablePresets.filter((preset): preset is DestinationPreset => preset !== null);
}
