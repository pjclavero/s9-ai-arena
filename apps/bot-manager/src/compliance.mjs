/**
 * E6/R1.7 · Postura de seguridad de contenedores — ÚNICA FUENTE DE VERDAD.
 *
 * Extraído de container-runner.ts (que lo re-exporta sin cambio de API) a un
 * módulo ESM plano para que TAMBIÉN pueda importarlo el escáner del Compose
 * (infrastructure/scripts/scan-compose.mjs) con `node` a secas, sin cargador
 * de TypeScript. Así el escáner y el runner dejan de poder contradecirse:
 * ambos preguntan a la misma función (ERR-SEC-02).
 *
 * Tipos en compliance.d.mts.
 */

/**
 * Comprueba que una postura cumple TODOS los controles de la tabla 18.2.
 * Devuelve las violaciones (vacío = cumple).
 * @param {import("./compliance.d.mts").CompliancePosture} p
 * @returns {string[]}
 */
export function complianceViolations(p) {
  const v = [];
  if (p.privileged) v.push("contenedor privilegiado");
  if (p.mountsDockerSock) v.push("monta el socket de Docker (/var/run/docker.sock)");
  if (!p.user || p.user === "root" || p.user === "0") v.push("corre como root");
  if (!p.capDropAll) v.push("no elimina todas las capabilities (cap-drop ALL)");
  if (!p.readonlyRootfs) v.push("filesystem raíz no es de solo lectura");
  if (!p.noNewPrivileges) v.push("falta no-new-privileges");
  if (!p.seccompProfile || p.seccompProfile === "unconfined") v.push("seccomp unconfined o ausente");
  if (p.hasExternalDns) v.push("tiene DNS externo (fuga a Internet)");
  if (p.networks.some((n) => n !== "arena")) v.push(`conectado a red no permitida: ${p.networks.join(",")}`);
  if (p.bindMounts.length) v.push(`bind-mounts presentes (posibles secretos): ${p.bindMounts.join(",")}`);
  if (p.tmpfsMounts.length === 0) v.push("sin /tmp por tmpfs limitado");
  return v;
}

/**
 * @param {import("./compliance.d.mts").CompliancePosture} p
 * @returns {void}
 */
export function assertCompliant(p) {
  const v = complianceViolations(p);
  if (v.length) throw new Error(`postura de seguridad NO conforme (tabla 18.2): ${v.join("; ")}`);
}

/**
 * Postura conforme de referencia (la que produce un `docker run` de la tabla
 * 18.2). Sirve de base para evaluar posturas parciales: se parte de una
 * postura conforme y se superponen SOLO los campos observados, de modo que
 * complianceViolations devuelva únicamente lo que de verdad se ha observado
 * mal (p. ej. el escáner del Compose solo observa privileged y docker.sock).
 * @returns {import("./compliance.d.mts").CompliancePosture}
 */
export function compliantBasePosture() {
  return {
    user: "10001:10001",
    capDropAll: true,
    readonlyRootfs: true,
    noNewPrivileges: true,
    seccompProfile: "security/seccomp-bot.json",
    networks: ["arena"],
    hasExternalDns: false,
    tmpfsMounts: ["/tmp"],
    mountsDockerSock: false,
    privileged: false,
    bindMounts: [],
    limits: {},
  };
}
