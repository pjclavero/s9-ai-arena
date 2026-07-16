/**
 * E6 · bot-manager — escaneo de secretos en el código subido (T6.4, etapa del pipeline).
 *
 * DoD T6.4: "Código con una clave AWS de ejemplo queda bloqueado en publicación con el
 * hallazgo registrado." E6.M lo justifica: protege también al propio usuario de subir
 * sus credenciales por error.
 *
 * Patrones deliberadamente conservadores (preferimos algún falso positivo bloqueante a
 * dejar pasar un secreto). Cada match devuelve la localización (fichero + línea) SIN
 * volcar el secreto entero al log.
 */
import type { SourceFile } from "./types.js";

export interface SecretMatch {
  file: string;
  line: number;
  kind: string;
  /** Fragmento enmascarado, nunca el secreto completo. */
  excerpt: string;
}

interface Pattern {
  kind: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { kind: "aws_access_key_id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    kind: "aws_secret_access_key",
    re: /\baws_secret_access_key\b\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i,
  },
  { kind: "github_token", re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { kind: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { kind: "slack_token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "google_api_key", re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { kind: "private_key_block", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: "generic_bearer", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}/ },
  {
    kind: "hardcoded_password",
    re: /\b(?:password|passwd|pwd)\b\s*[:=]\s*['"][^'"\s]{6,}['"]/i,
  },
];

function mask(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= 8) return "****";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-2)} (${trimmed.length} chars)`;
}

export function scanSecrets(files: SourceFile[]): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const f of files) {
    const lines = f.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const p of PATTERNS) {
        const m = p.re.exec(lines[i]);
        if (m) {
          found.push({ file: f.path, line: i + 1, kind: p.kind, excerpt: mask(m[0]) });
        }
      }
    }
  }
  return found;
}
