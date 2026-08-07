import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cleanText } from "./security.mjs";

const execFileAsync = promisify(execFile);
const API_ENVIRONMENT_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_APPLICATION_CREDENTIALS"
];

export function geminiSubscriptionEnvironment(source = process.env) {
  const environment = { ...source };
  for (const key of API_ENVIRONMENT_KEYS) delete environment[key];
  return environment;
}

export async function findGeminiCli(environment = process.env) {
  const configured = cleanText(environment.GEMINI_CLI_BIN, 2000);
  if (configured) return configured;
  try {
    const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", ["gemini"], {
      windowsHide: true,
      timeout: 5000,
      env: environment
    });
    return String(stdout || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

export function geminiCliArgs(model = "") {
  const configuredModel = cleanText(model, 120);
  return ["--output-format", "json", ...(configuredModel ? ["--model", configuredModel] : [])];
}

export function parseGeminiCliOutput(raw) {
  const text = cleanText(raw, 180000);
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const candidates = [
      parsed.response,
      parsed.text,
      parsed.output,
      parsed.result?.response,
      parsed.result?.text,
      parsed.result?.output,
      parsed.content?.text,
      parsed.message?.content
    ];
    const result = candidates.find((value) => typeof value === "string" && value.trim());
    return cleanText(result || "", 120000);
  } catch {
    return text;
  }
}

function quoteForCmd(value) {
  return `"${String(value).replaceAll("\"", "\\\"")}"`;
}

export function spawnGeminiCli(binary, args, options = {}) {
  const isWindowsCommandScript = os.platform() === "win32" && /\.(cmd|bat)$/i.test(binary || "");
  if (!isWindowsCommandScript) return spawn(binary, args, options);
  const command = [quoteForCmd(binary), ...args.map(quoteForCmd)].join(" ");
  return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], options);
}
