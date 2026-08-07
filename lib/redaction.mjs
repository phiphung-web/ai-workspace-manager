const SECRET_PATTERNS = [
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "api-key", pattern: /\b(?:sk(?:-[A-Za-z0-9]+)*[-_]|AIza|ghp_|github_pat_)[A-Za-z0-9_\-]{12,}\b/g },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { name: "secret-assignment", pattern: /\b(API_KEY|TOKEN|PASSWORD|SECRET|PRIVATE_KEY)\s*[:=]\s*([^\s,;]+)/gi }
];

export function redactSecrets(value) {
  let text = String(value || "");
  const redactions = [];
  for (const item of SECRET_PATTERNS) {
    text = text.replace(item.pattern, (match, name) => {
      redactions.push(item.name);
      return item.name === "secret-assignment" ? `${name}=[REDACTED]` : `[REDACTED:${item.name}]`;
    });
  }
  return { text, redactions: [...new Set(redactions)] };
}

export function isSensitivePath(file) {
  const normalized = String(file || "").replaceAll("\\", "/").toLowerCase();
  return /(^|\/)(\.env(?:\.|$)|auth\.json$|secrets?\.|credentials?|id_rsa|id_ed25519|\.npmrc$)/.test(normalized);
}
