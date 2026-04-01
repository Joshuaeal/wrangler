import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

export type AppSettings = {
  advancedMetadataEnabled: boolean;
  instanceName: string;
};

const settingsPath = path.join(config.appDataRoot, "app-settings.json");

function buildDefaultSettings(): AppSettings {
  return {
    advancedMetadataEnabled: false,
    instanceName: ""
  };
}

export function getAppSettings(): AppSettings {
  if (!fs.existsSync(settingsPath)) {
    return buildDefaultSettings();
  }

  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Partial<AppSettings>;
  return {
    advancedMetadataEnabled: Boolean(parsed.advancedMetadataEnabled),
    instanceName: typeof parsed.instanceName === "string" ? parsed.instanceName.trim() : ""
  };
}

export async function saveAppSettings(input: Partial<AppSettings>): Promise<AppSettings> {
  const current = getAppSettings();
  const nextSettings: AppSettings = {
    advancedMetadataEnabled:
      typeof input.advancedMetadataEnabled === "boolean"
        ? input.advancedMetadataEnabled
        : current.advancedMetadataEnabled,
    instanceName:
      typeof input.instanceName === "string"
        ? input.instanceName.trim().slice(0, 80)
        : current.instanceName
  };

  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(nextSettings, null, 2));
  return nextSettings;
}
