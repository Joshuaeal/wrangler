import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { assertInsideRoot } from "./paths.js";

export type DestinationSettings = {
  projectRoot: string;
  destinationA: string;
  destinationB: string;
  destinationBEnabled: boolean;
  destinationC: string;
  destinationCEnabled: boolean;
};

const settingsPath = path.join(config.appDataRoot, "destination-settings.json");

export function getDestinationSettings(): DestinationSettings {
  if (!fs.existsSync(settingsPath)) {
    const defaults = {
      projectRoot: config.projectsRoot,
      destinationA: config.destARoot,
      destinationB: config.destBRoot,
      destinationBEnabled: false,
      destinationC: config.destCRoot,
      destinationCEnabled: false
    };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(defaults, null, 2));
    return defaults;
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
    destinationB: normalizeDestinationPath(input.destinationB),
    destinationBEnabled: Boolean(input.destinationBEnabled),
    destinationC: normalizeDestinationPath(input.destinationC),
    destinationCEnabled: Boolean(input.destinationCEnabled)
  };

  for (const destination of [normalized.projectRoot, normalized.destinationA, normalized.destinationB, normalized.destinationC]) {
    await fsp.mkdir(destination, { recursive: true });
  }

  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(normalized, null, 2));
  return normalized;
}

export async function listMacDirectories(relativePath = "."): Promise<Array<{ name: string; path: string }>> {
  const root = config.macDestinationRoot;
  const directory = assertInsideRoot(root, relativePath === "." ? root : relativePath);
  const entries = await fsp.readdir(directory, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({
      name: entry.name,
      path: path.join(directory, entry.name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeDestinationPath(input: string): string {
  return assertInsideRoot(config.macDestinationRoot, input);
}
