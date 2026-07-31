import path from "node:path";

export function isAllowedOrigin(origin, port) {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.port === String(port) &&
      parsed.protocol === "http:"
    );
  } catch {
    return false;
  }
}

export function cleanText(value, max = 5000) {
  return String(value ?? "").replace(/\0/g, "").trim().slice(0, max);
}

export function safeId(value) {
  const id = String(value ?? "");
  if (!/^[a-z0-9-]{8,80}$/i.test(id)) throw new Error("Mã dữ liệu không hợp lệ.");
  return id;
}

export function normalizeProjectPath(value) {
  const input = cleanText(value, 2000);
  if (!input || !path.isAbsolute(input)) {
    throw new Error("Đường dẫn dự án phải là đường dẫn tuyệt đối.");
  }
  return path.resolve(input);
}
