import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const PROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$plain=[Console]::In.ReadToEnd()",
  "$bytes=[Text.Encoding]::UTF8.GetBytes($plain)",
  "$cipher=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Convert]::ToBase64String($cipher))"
].join(";");

const UNPROTECT_SCRIPT = [
  "Add-Type -AssemblyName System.Security",
  "$encoded=[Console]::In.ReadToEnd()",
  "$cipher=[Convert]::FromBase64String($encoded)",
  "$bytes=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($bytes))"
].join(";");

function powershell(script, input) {
  if (process.platform !== "win32") {
    throw new Error("Kho key mã hóa hiện chỉ hỗ trợ Windows DPAPI.");
  }
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(stderr.trim() || `DPAPI kết thúc với mã ${code}.`)));
    child.stdin.end(input, "utf8");
  });
}

export class SecretVault {
  constructor(dataRoot) {
    this.file = path.join(dataRoot, "secrets.json");
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      return JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }

  async write(value) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.file);
  }

  set(id, secret) {
    const operation = this.queue.then(async () => {
      const values = await this.read();
      values[id] = await powershell(PROTECT_SCRIPT, secret);
      await this.write(values);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async get(id) {
    const values = await this.read();
    if (!values[id]) throw new Error("Provider chưa có API key.");
    return powershell(UNPROTECT_SCRIPT, values[id]);
  }
}
