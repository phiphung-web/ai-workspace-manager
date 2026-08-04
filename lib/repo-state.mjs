import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanText } from "./security.mjs";

const execFileAsync = promisify(execFile);

async function git(projectPath, args) {
  const result = await execFileAsync("git", ["-C", projectPath, ...args], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 256 * 1024
  });
  return cleanText(result.stdout, 12000).trim();
}

export async function readRepoState(projectPath) {
  try {
    const [branch, commit, status, diffStat, stagedStat] = await Promise.all([
      git(projectPath, ["branch", "--show-current"]),
      git(projectPath, ["rev-parse", "HEAD"]),
      git(projectPath, ["status", "--short"]),
      git(projectPath, ["diff", "--stat"]),
      git(projectPath, ["diff", "--cached", "--stat"])
    ]);
    return {
      available: true,
      branch: branch || "detached HEAD",
      commit,
      workingTree: status || "clean",
      diffStat: diffStat || "none",
      stagedStat: stagedStat || "none",
      capturedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      available: false,
      error: cleanText(error.message, 1000),
      capturedAt: new Date().toISOString()
    };
  }
}
