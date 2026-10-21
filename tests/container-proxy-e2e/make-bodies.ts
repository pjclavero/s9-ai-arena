/**
 * RC2 DEV-CI · cuerpos de `POST /containers/create` para las sondas del E2E
 * contenedor → proxy (tests/container-proxy-e2e/run.sh).
 *
 * El cuerpo VÁLIDO no se escribe a mano: sale de `ProxyContainerRunner.buildCreateBody`,
 * el MISMO constructor que usan el bot-build-worker y el tournament-worker, con la imagen
 * de runtime de `runtimes/DIGESTS.lock` (3ª columna), el perfil seccomp real y los límites
 * por defecto. Así «ACCESS» en una sonda significa exactamente «este origen podría lanzar
 * un bot», y no «el proxy aceptó un cuerpo que ningún flujo real envía».
 *
 * Los cuerpos AJENOS son ese mismo cuerpo con UNA sola diferencia (la imagen o las
 * labels), para que un 403 sólo pueda deberse a esa diferencia:
 *   foreign-postgres      imagen de postgres del compose resuelto (por digest)
 *   foreign-base-python   imagen BASE de DIGESTS.lock (2ª columna): el contrato la excluye
 *   foreign-digest        repo del runtime con un digest que no está en el lock
 *   label-forgery         imagen válida, pero el cliente intenta fijar labels `s9.*`
 *
 * Uso: tsx tests/container-proxy-e2e/make-bodies.ts <compose-config.json> <dir-salida>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProxyContainerRunner } from "../../apps/bot-manager/src/docker-proxy.js";
import { DEFAULT_LIMITS } from "../../apps/bot-manager/src/container-runner.js";
import { DEFAULT_SECCOMP_PROFILE } from "../../apps/bot-manager/src/container-battle.js";

const [composePath, outDir] = process.argv.slice(2);
if (!composePath || !outDir) {
  console.error("uso: make-bodies.ts <compose-config.json> <dir-salida>");
  process.exit(2);
}

/** Columnas de DIGESTS.lock: <runtime> <base> <imagen de runtime>. */
function readLock(path: string): { runtime: string; base: string; image: string }[] {
  const rows: { runtime: string; base: string; image: string }[] = [];
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const [runtime, base, image] = line.split(/\s+/);
    if (runtime && base && image) rows.push({ runtime, base, image });
  }
  return rows;
}

const lock = readLock(join(process.cwd(), "runtimes", "DIGESTS.lock"));
const py = lock.find((r) => r.runtime === "python");
if (!py) throw new Error("DIGESTS.lock sin runtime python");

const compose = JSON.parse(readFileSync(composePath, "utf8")) as { services: Record<string, { image?: string }> };
const postgresImage = compose.services.postgres?.image ?? "";
if (!/@sha256:[0-9a-f]{64}$/.test(postgresImage))
  throw new Error(`postgres sin digest en el compose: ${postgresImage}`);

// Un digest real (no placeholder) que NO está en el lock: el del runtime node bajo el
// repo del runtime python. Coincidencia EXACTA ⇒ tiene que denegarse.
const node = lock.find((r) => r.runtime === "node");
const otherDigest = (node?.image ?? "").split("@")[1];
const foreignDigestImage = `${py.image.split("@")[0]}@${otherDigest}`;
if (lock.some((r) => r.image === foreignDigestImage)) throw new Error("el digest ajeno está en el lock");

const valid = ProxyContainerRunner.buildCreateBody({
  imageDigest: py.image,
  botId: "rc2ci-probe",
  version: 1,
  battleId: "rc2ci-probe",
  network: "arena",
  engineEndpoint: "ws://rc2ci-probe.invalid:1",
  env: { S9_RC2CI_PROBE: "1" },
  limits: DEFAULT_LIMITS,
  seccompProfilePath: DEFAULT_SECCOMP_PROFILE,
  cmd: ["-c", "pass"],
});

const bodies: Record<string, unknown> = {
  valid,
  "foreign-postgres": { ...valid, Image: postgresImage },
  "foreign-base-python": { ...valid, Image: py.base },
  "foreign-digest": { ...valid, Image: foreignDigestImage },
  "label-forgery": { ...valid, Labels: { "s9.managed": "true", "s9.proxy.instance": "rc2ci-forged" } },
};

mkdirSync(outDir, { recursive: true });
for (const [name, body] of Object.entries(bodies)) {
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(body));
}
writeFileSync(
  join(outDir, "images.json"),
  JSON.stringify({
    runtimeImages: lock.map((r) => r.image),
    baseImages: lock.map((r) => r.base),
    postgresImage,
    foreignDigestImage,
  }),
);
console.log(`cuerpos escritos en ${outDir}: ${Object.keys(bodies).join(", ")}`);
