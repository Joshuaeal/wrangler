import { spawn } from "node:child_process";
import process from "node:process";

const projectRoot = process.cwd();

console.log("Restarting api and worker to pick up newly mounted volumes...");
await runCommand("docker", ["compose", "restart", "api", "worker"], { cwd: projectRoot });
console.log("Done. Wrangler can now see any volumes mounted since last start.");

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: "inherit",
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
