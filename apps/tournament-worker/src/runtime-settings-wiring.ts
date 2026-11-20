/**
 * MG · Cableado de los ajustes de runtime en el tournament-worker (FAIL-CLOSED).
 *
 * El worker NO crea la fila (no recibe S9_PUBLIC_REPLAYS_ENABLED): sólo la lee. Si la BD
 * no responde en el arranque, o aún no hay fila, el espectador público vale FALSE (nunca
 * el entorno); si la BD falla en caliente, se conserva el último valor sólo durante
 * `staleMs` (3 × S9_RUNTIME_SETTINGS_REFRESH_MS por defecto) y luego FALSE.
 */
import type { Db } from "../../api/src/db/connection.js";
import { RuntimeSettingsStore, type RuntimeSettingsOptions } from "../../api/src/runtime-settings.js";

export async function startWorkerRuntimeSettings(
  db: Db,
  opts: Omit<RuntimeSettingsOptions, "bootstrap" | "fixed"> = {},
): Promise<{ store: RuntimeSettingsStore; publicSpectateEnabled: () => boolean }> {
  const store = new RuntimeSettingsStore(db, { ...opts, bootstrap: false });
  await store.refresh(); // un fallo aquí NO es fatal: el store queda cerrado hasta una lectura válida
  store.start();
  return { store, publicSpectateEnabled: () => store.publicVisibility().publicSpectate };
}
