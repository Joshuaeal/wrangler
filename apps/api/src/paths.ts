import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const allowedRoots = [
  config.sourceRoot,
  config.projectsRoot,
  config.destARoot,
  config.destBRoot,
  config.destCRoot,
  config.destDRoot,
  config.macDestinationRoot
];

export function ensureDirectories(): void {
  for (const dir of [config.appDataRoot, path.dirname(config.databasePath), config.projectsRoot, config.destARoot, config.destBRoot, config.destCRoot, config.destDRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function assertInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);

  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes root: ${candidate}`);
  }

  return resolvedCandidate;
}

export function assertKnownRoot(candidate: string): string {
  const resolved = path.resolve(candidate);
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`Path is not inside an allowed root: ${candidate}`);
  }
  return resolved;
}

export function relativeToRoot(root: string, candidate: string): string {
  const resolved = assertInsideRoot(root, candidate);
  return path.relative(root, resolved) || ".";
}
