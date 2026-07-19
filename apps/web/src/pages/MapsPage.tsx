/**
 * R8.2 · Gestión de mapas en el panel: listar versiones, importar (validación
 * REAL de E4/T4.2), generar procedural (E4/T4.4) y publicar (inmutable).
 *
 * La interfaz solo OCULTA/deshabilita; la autorización la hace la API (cap. 16):
 * importar exige rol `user`, generar y publicar exigen `organizer`. Un rechazo
 * de la API se ANUNCIA con role="alert" (nunca se traga), igual que el resto del
 * panel (R3.7). La ejecución real de batallas (mapa publicado ⇒ jugable) vive en
 * el pipeline de VM108 y NO se dispara desde aquí.
 */
import { useEffect, useState } from "react";
import { api, ApiRequestError, type Me } from "../api.js";

interface MapVersion {
  mapId: string;
  version: number;
  state: "draft" | "validated" | "published";
  checksum?: string;
  widthM?: number;
  heightM?: number;
  supportedModes: string[];
  thumbnailUrl?: string;
  generation?: { seed?: string; generator?: string };
}

interface ValidationCheck {
  check: string;
  severity: "error" | "warning" | "info";
  message: string;
}

/** Extrae los `checks` del validador de E4 que la API adjunta a un 422. */
function checksOf(e: unknown): ValidationCheck[] {
  if (e instanceof ApiRequestError && Array.isArray((e.body as { checks?: unknown }).checks)) {
    return (e.body as { checks: ValidationCheck[] }).checks;
  }
  return [];
}

function stateClass(state: MapVersion["state"]): string {
  if (state === "published") return "ok";
  if (state === "validated") return "warn";
  return "";
}

export function MapsPage(_props: { me: Me }) {
  const [maps, setMaps] = useState<MapVersion[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [checks, setChecks] = useState<ValidationCheck[]>([]);
  const [notice, setNotice] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [seed, setSeed] = useState("");
  const [params, setParams] = useState('{ "widthM": 40, "heightM": 40, "modes": ["deathmatch"] }');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setLoadError("");
    try {
      const page = await api<{ items: MapVersion[] }>("GET", "/maps");
      setMaps(page.items);
    } catch (e) {
      setMaps(null);
      setLoadError(`No se pudo cargar los mapas: ${(e as Error).message}`);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  function resetFeedback() {
    setActionError("");
    setChecks([]);
    setNotice("");
  }

  async function importMap() {
    if (!file) return;
    resetFeedback();
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const created = await api<MapVersion>("POST", "/maps", undefined, { formData: fd });
      setNotice(`Mapa "${created.mapId}" importado y validado (v${created.version}, borrador).`);
      setFile(null);
      await refresh();
    } catch (e) {
      const c = checksOf(e);
      if (c.length > 0) setChecks(c);
      setActionError(`No se pudo importar el mapa: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function generateMap() {
    resetFeedback();
    let parsed: unknown;
    try {
      parsed = JSON.parse(params);
    } catch {
      setActionError("Los parámetros deben ser JSON válido.");
      return;
    }
    setBusy(true);
    try {
      const created = await api<MapVersion>("POST", "/maps/generate", { params: parsed, seed });
      setNotice(`Mapa "${created.mapId}" generado y validado (semilla ${seed}).`);
      await refresh();
    } catch (e) {
      const c = checksOf(e);
      if (c.length > 0) setChecks(c);
      setActionError(`No se pudo generar el mapa: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function publish(m: MapVersion) {
    resetFeedback();
    setBusy(true);
    try {
      await api("POST", `/maps/${encodeURIComponent(m.mapId)}/versions/${m.version}/actions/publish`);
      setNotice(`Mapa "${m.mapId}" v${m.version} publicado: ya es jugable en batallas.`);
      await refresh();
    } catch (e) {
      setActionError(`No se pudo publicar: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="card">
        <h2>Mapas</h2>
        <p>
          <a href="#/maps/editor">Abrir editor de mapas (borrador local)</a> — R10, foundation: diseña un mapa y
          expórtalo a JSON. La importación/validación real sigue haciéndose desde los controles de abajo.
        </p>
        <p>
          Importa un mapa (JSON interno o export de Tiled) o genera uno procedural. Ambos pasan por el validador real
          antes de guardarse. Solo un mapa <strong>publicado</strong> puede usarse en una batalla; la ejecución real la
          realiza el pipeline de la arena, no este panel.
        </p>

        <fieldset>
          <legend>Importar un mapa existente</legend>
          <input
            type="file"
            accept="application/json,.json"
            aria-label="archivo-mapa"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />{" "}
          <button type="button" disabled={busy || !file} onClick={() => void importMap()}>
            Importar mapa
          </button>
        </fieldset>

        <fieldset>
          <legend>Generar un mapa procedural</legend>
          <label>
            Semilla{" "}
            <input
              aria-label="semilla"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
              placeholder="p. ej. s9-01"
            />
          </label>{" "}
          <label>
            Parámetros (JSON)
            <br />
            <textarea
              aria-label="parámetros"
              rows={3}
              cols={48}
              value={params}
              onChange={(e) => setParams(e.target.value)}
            />
          </label>
          <br />
          <button type="button" disabled={busy || !seed} onClick={() => void generateMap()}>
            Generar mapa
          </button>
        </fieldset>

        {notice && (
          <p className="ok" role="status" aria-live="polite">
            {notice}
          </p>
        )}
        {actionError && (
          <div role="alert">
            <p className="error">{actionError}</p>
            {checks.length > 0 && (
              <ul data-testid="validation-checks">
                {checks.map((c, i) => (
                  <li key={i} className={c.severity === "error" ? "error" : "warn"}>
                    [{c.check}] {c.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h3>Mapas registrados</h3>
        {loadError ? (
          <div role="alert">
            <p className="error">{loadError}</p>
            <button type="button" onClick={() => void refresh()}>
              Reintentar
            </button>
          </div>
        ) : maps === null ? (
          <p role="status" aria-live="polite">
            Cargando…
          </p>
        ) : maps.length === 0 ? (
          <p>No hay mapas todavía.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Mapa</th>
                <th>Versión</th>
                <th>Estado</th>
                <th>Dimensiones</th>
                <th>Modos</th>
                <th>Vista previa</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {maps.map((m) => (
                <tr key={`${m.mapId}@${m.version}`}>
                  <td>{m.mapId}</td>
                  <td>v{m.version}</td>
                  <td className={stateClass(m.state)}>{m.state}</td>
                  <td>{m.widthM != null && m.heightM != null ? `${m.widthM}×${m.heightM} m` : "—"}</td>
                  <td>{m.supportedModes.length ? m.supportedModes.join(", ") : "—"}</td>
                  <td>
                    {m.thumbnailUrl ? (
                      <img
                        src={m.thumbnailUrl}
                        alt={`vista previa de ${m.mapId} v${m.version}`}
                        width={64}
                        height={64}
                      />
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {m.state === "published" ? (
                      <span className="ok">Disponible para batallas</span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`publicar-${m.mapId}-v${m.version}`}
                        disabled={busy}
                        onClick={() => void publish(m)}
                      >
                        Publicar
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
