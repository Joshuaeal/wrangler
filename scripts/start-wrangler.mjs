import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const projectRoot = process.cwd();
const runtimeDir = path.join(projectRoot, "data", "runtime");
const helperName = process.platform === "win32" ? "windows-host-helper" : "host-helper";
const helperLogPath = path.join(runtimeDir, `${helperName}.log`);
const helperPidPath = path.join(runtimeDir, `${helperName}.pid`);
const controlToken = process.env.HOST_HELPER_CONTROL_TOKEN ?? "wrangler-local-control";
const gitSha = await readCommandOutput("git", ["rev-parse", "HEAD"]).catch(() => "");
const githubRepo = await detectGitHubRepo();

await fs.mkdir(runtimeDir, { recursive: true });

if (!(await isHostHelperHealthy())) {
  await startHostHelper();
}

await runCommand("docker", ["compose", "up", "-d", "--build"], { cwd: projectRoot });

console.log("Wrangler is running in the background.");
console.log("Open http://localhost:5173 or your machine IP in a browser.");
console.log("Use Settings -> Stop Wrangler to stop only Wrangler services later.");

async function isHostHelperHealthy() {
  try {
    const response = await fetch("http://127.0.0.1:4100/health");
    return response.ok;
  } catch {
    return false;
  }
}

async function startHostHelper() {
  const logFile = await fs.open(helperLogPath, "a");
  const child = process.platform === "win32"
    ? spawn(
        "dotnet",
        ["run", "--project", "apps/windows-host-helper/WindowsHostHelper.csproj"],
        {
          cwd: projectRoot,
          detached: true,
          stdio: ["ignore", logFile.fd, logFile.fd],
          env: {
            ...process.env,
            WRANGLER_PROJECT_ROOT: projectRoot,
            HOST_HELPER_CONTROL_TOKEN: controlToken
          }
        }
      )
    : spawn(process.execPath, ["apps/host-helper/dist/index.js"], {
        cwd: projectRoot,
        detached: true,
        stdio: ["ignore", logFile.fd, logFile.fd],
        env: {
          ...process.env,
          WRANGLER_PROJECT_ROOT: projectRoot,
          HOST_HELPER_CONTROL_TOKEN: controlToken
        }
      });

  child.unref();
  await fs.writeFile(helperPidPath, String(child.pid));
  await logFile.close();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await isHostHelperHealthy()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Host helper did not start. Check ${helperLogPath}`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_APP_GIT_SHA: gitSha,
        VITE_GITHUB_REPO: githubRepo,
        VITE_GITHUB_BRANCH: "main"
      }
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function readCommandOutput(command, args) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });
}

async function detectGitHubRepo() {
  try {
    const remoteUrl = await readCommandOutput("git", ["remote", "get-url", "origin"]);
    const sshMatch = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/i);
    return sshMatch?.[1] ?? "";
  } catch {
    return "";
  }
}
