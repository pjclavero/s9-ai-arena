/**
 * E6 · bot-manager — escáner de seguridad del Compose (T6.2, criterio cap. 28).
 *
 * DoD T6.2: "Escaneo en CI que falla si algún servicio del Compose monta docker.sock o
 * corre privilegiado."
 *
 * NO se usa un parser YAML externo (no hay dependencia en el repo y añadir una no aporta
 * seguridad): se hace un análisis por líneas robusto a comentarios y comillas, suficiente
 * para las señales que importan. Devuelve la lista de infracciones; vacío = limpio.
 *
 * Esta capa SÍ es verificable aquí (opera sobre ficheros .yml), a diferencia del
 * lanzamiento real de contenedores.
 */

export interface ComposeViolation {
  line: number;
  rule: "docker_sock_mount" | "privileged" | "cap_add_all" | "security_opt_unconfined" | "host_network" | "pid_host";
  text: string;
}

const RULES: { rule: ComposeViolation["rule"]; re: RegExp }[] = [
  { rule: "docker_sock_mount", re: /\/var\/run\/docker\.sock|(^|[\s'"[])docker\.sock/ },
  { rule: "privileged", re: /^\s*privileged\s*:\s*true\b/ },
  { rule: "cap_add_all", re: /^\s*-?\s*(?:cap_add\s*:\s*)?\[?\s*['"]?ALL['"]?\s*\]?\s*$/i },
  { rule: "security_opt_unconfined", re: /seccomp\s*[:=]\s*unconfined|apparmor\s*[:=]\s*unconfined/i },
  { rule: "host_network", re: /^\s*network_mode\s*:\s*['"]?host['"]?/ },
  { rule: "pid_host", re: /^\s*pid\s*:\s*['"]?host['"]?/ },
];

export function scanCompose(yaml: string): ComposeViolation[] {
  const out: ComposeViolation[] = [];
  const lines = yaml.split(/\r?\n/);
  let inCapAdd = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, "");
    if (!line.trim()) continue;

    // seguimiento de un bloque cap_add: para detectar "- ALL" en la línea siguiente
    if (/^\s*cap_add\s*:/.test(line)) {
      inCapAdd = true;
      if (/\bALL\b/.test(line)) out.push({ rule: "cap_add_all", line: i + 1, text: raw.trim() });
      continue;
    }
    if (inCapAdd) {
      if (/^\s*-\s*/.test(line)) {
        if (/\bALL\b/i.test(line)) out.push({ rule: "cap_add_all", line: i + 1, text: raw.trim() });
        continue;
      }
      inCapAdd = false;
    }

    for (const { rule, re } of RULES) {
      if (rule === "cap_add_all") continue; // gestionado arriba
      if (re.test(line)) out.push({ rule, line: i + 1, text: raw.trim() });
    }
  }
  return out;
}
