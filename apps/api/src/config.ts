import dotenv from "dotenv";
import path from "node:path";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 4001),
  uiOrigin: required("UI_ORIGIN", "http://localhost:5173"),
  databasePath: required("DATABASE_PATH", "/data/db/wrangler.db"),
  hostHelperUrl: required("HOST_HELPER_URL", "http://host.docker.internal:4100"),
  hostHelperControlToken: process.env.HOST_HELPER_CONTROL_TOKEN ?? "wrangler-local-control",
  sourceRoot: path.resolve(required("SOURCE_ROOT", "/Volumes")),
  projectsRoot: path.resolve(required("PROJECTS_ROOT", "/storage/projects")),
  destARoot: path.resolve(required("DEST_A_ROOT", "/storage/destination-a")),
  destBRoot: path.resolve(required("DEST_B_ROOT", "/storage/destination-b")),
  destCRoot: path.resolve(process.env.DEST_C_ROOT ?? "/storage/destination-c"),
  destDRoot: path.resolve(process.env.DEST_D_ROOT ?? "/storage/destination-d"),
  allowSourceWrite: process.env.ALLOW_SOURCE_WRITE === "true",
  appDataRoot: path.resolve(required("APP_DATA_ROOT", "/data")),
  macDestinationRoot: path.resolve(process.env.MAC_DESTINATION_ROOT ?? "/Users")
};
