import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(process.env.WRANGLER_PROJECT_ROOT ?? process.cwd());

await runCommand("docker", ["compose", "down"], { cwd: projectRoot });

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "ignore",
      env: process.env
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
