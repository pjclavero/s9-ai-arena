/**
 * R17 · Sonda REAL de overrides de versión por servicio (#143).
 *
 * NO reimplementa nada: ejecuta `infrastructure/scripts/tag-override-gate.mjs
 * --json`, que es la única autoridad sobre qué override tiene EFECTO y cuál
 * está declarado. Dos implementaciones serían dos verdades, y la de aquí sería
 * la que nadie calibra.
 *
 * Regla que gobierna todo el fichero: `probed: false` significa NO SE HA
 * MIRADO, nunca "no hay overrides". Confundir las dos cosas es la forma exacta
 * en que un override se vuelve invisible — que es el defecto que este carril
 * existe para impedir.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ReadinessProbes } from "./engine.ts";

const ejecutar = promisify(execFile);

export type SalidaGate = {
  global_tag?: string | null;
  overrides?: Record<string, { imagen?: string; tag?: string }>;
  fallos?: Array<{ codigo?: string; detalle?: string }>;
};

/**
 * Traduce la salida del gate al vocabulario de la sonda. Separado del proceso
 * para poder calibrarlo sin lanzar nada: la interpretación es lo que puede
 * equivocarse, y se prueba aparte de la tubería que la alimenta.
 */
export function interpretarSalidaGate(salida: SalidaGate): {
  globalTag: string | null;
  active: Array<{ service: string; tag: string }>;
  undeclared: string[];
} {
  const active = Object.entries(salida?.overrides ?? {})
    .map(([service, o]) => ({ service, tag: String(o?.tag ?? "") }))
    .sort((a, b) => a.service.localeCompare(b.service));
  // Los NO declarados no se deducen aquí: el gate ya los emite con su propio
  // código. Recalcularlos sería una segunda opinión sin calibrar.
  const undeclared = (salida?.fallos ?? [])
    .filter((f) => f?.codigo === "OVERRIDE_NO_DECLARADO")
    .map((f) =>
      String(f?.detalle ?? "")
        .split(":")[0]
        .trim(),
    )
    .filter(Boolean);
  return { globalTag: salida?.global_tag ?? null, active, undeclared: [...new Set(undeclared)] };
}

/**
 * @param raizRepo raíz del repositorio donde vive el gate. Vacía = no se puede
 *   mirar, y la sonda lo dice en vez de aprobar por omisión.
 */
export function versionOverridesProbe(
  raizRepo: string,
  correr: (cmd: string, args: string[]) => Promise<{ stdout: string }> = (cmd, args) =>
    ejecutar(cmd, args, { encoding: "utf8" }) as Promise<{ stdout: string }>,
): ReadinessProbes["versionOverrides"] {
  return async () => {
    if (!raizRepo)
      return {
        probed: false,
        globalTag: null,
        active: [],
        undeclared: [],
        reason: "sin S9_READINESS_REPO no hay contrato ni compose que mirar; no haber mirado NO es «no hay overrides»",
      };
    try {
      const { stdout } = await correr(process.execPath, [
        `${raizRepo}/infrastructure/scripts/tag-override-gate.mjs`,
        "--json",
      ]);
      return { probed: true, ...interpretarSalidaGate(JSON.parse(stdout) as SalidaGate) };
    } catch (err) {
      // El gate salió con rc!=0 (hay fallos) pero SÍ imprimió el JSON: eso es
      // una observación válida, no un error de la sonda. Sólo si no hay JSON
      // legible se declara no ejercida.
      const salida = (err as { stdout?: string })?.stdout;
      if (salida) {
        try {
          return { probed: true, ...interpretarSalidaGate(JSON.parse(salida) as SalidaGate) };
        } catch {
          /* cae al no ejercido de abajo */
        }
      }
      return {
        probed: false,
        globalTag: null,
        active: [],
        undeclared: [],
        reason: `el gate de overrides no se pudo ejecutar o no devolvió JSON: ${(err as Error).message}`,
      };
    }
  };
}
