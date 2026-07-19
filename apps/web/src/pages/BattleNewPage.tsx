/**
 * R9 · Crear una batalla de práctica desde la UI (modo prepared/seguro).
 *
 * Usa el endpoint EXISTENTE y seguro `POST /battles` (createPracticeBattle, RBAC
 * x-min-role: user), que ENCOLA una batalla no oficial. NO habla con Docker, NO salta
 * bot-manager/firma/digest ni el s9-docker-proxy, NO usa mocks. La ejecución con runner
 * containerizado (código no confiable aislado) es un flujo operativo opt-in (arnés
 * `e2e-real-battle-smoke`) y NO se dispara desde aquí.
 *
 * Solo permite mapas PUBLICADOS y bots con versión PUBLICADA (ready/signed).
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";

/** modo → ruleset por defecto (mismo mapeo que engine-executor). */
const MODE_RULESET: Record<string, string> = {
  deathmatch: "dm_practice@1",
  team_deathmatch: "tdm_mvp@1",
  capture_the_flag: "ctf_mvp@1",
  zone_control: "zc_mvp@1",
};

interface MapVersion {
  mapId: string;
  version: number;
  state: string;
  supportedModes?: string[];
}
interface BotSummary {
  id: string;
  name: string;
  latestPublishedVersion?: number | null;
}

export function BattleNewPage(_props: { me: Me }) {
  const [maps, setMaps] = useState<MapVersion[]>([]);
  const [bots, setBots] = useState<BotSummary[]>([]);
  const [loadErr, setLoadErr] = useState("");
  const [mode, setMode] = useState("deathmatch");
  const [mapId, setMapId] = useState("");
  const [seed, setSeed] = useState("");
  const [redBot, setRedBot] = useState("");
  const [blueBot, setBlueBot] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  // R6.2/R9-B · capability de ejecución real (la decide el backend; nunca secretos).
  const [runCap, setRunCap] = useState<{ enabled: boolean; available: boolean }>({ enabled: false, available: false });
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<{ status: string; replay?: { ingested?: boolean } | null } | null>(null);
  const [runErr, setRunErr] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const [m, b] = await Promise.all([
          api<{ items: MapVersion[] }>("GET", "/maps"),
          api<{ items: BotSummary[] }>("GET", "/bots"),
        ]);
        setMaps((m.items ?? []).filter((x) => x.state === "published"));
        setBots((b.items ?? []).filter((x) => x.latestPublishedVersion != null));
      } catch (e) {
        setLoadErr((e as Error).message);
      }
      try {
        const st = await api<{ realBattleRuns?: { enabled: boolean; available: boolean } }>("GET", "/system/status");
        if (st.realBattleRuns) setRunCap(st.realBattleRuns);
      } catch {
        /* si /system/status no responde, Run queda deshabilitado (fail-closed). */
      }
    })();
  }, []);

  async function runReal(battleId: string) {
    setRunErr("");
    setRunning(true);
    try {
      const res = await api<{ status: string; replay?: { ingested?: boolean } | null }>(
        "POST",
        `/battles/${encodeURIComponent(battleId)}/run`,
      );
      setRunResult(res);
    } catch (e) {
      setRunErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  function botVersion(id: string): number | undefined {
    const v = bots.find((x) => x.id === id)?.latestPublishedVersion;
    return v == null ? undefined : v;
  }
  function mapVersion(id: string): number | undefined {
    return maps.find((x) => x.mapId === id)?.version;
  }

  const notEnoughBots = bots.length < 2;
  const notEnoughMaps = maps.length < 1;

  async function submit() {
    setError("");
    if (!mapId) return setError("Elige un mapa publicado.");
    if (!redBot || !blueBot) return setError("Elige dos bots con versión publicada.");
    if (redBot === blueBot) return setError("Elige dos bots distintos.");
    const rv = botVersion(redBot);
    const bv = botVersion(blueBot);
    if (rv == null || bv == null) return setError("Los bots elegidos no tienen versión publicada.");
    setSubmitting(true);
    try {
      const battle = await api<{ id: string }>("POST", "/battles", {
        mode,
        rulesetId: MODE_RULESET[mode],
        mapId,
        mapVersion: mapVersion(mapId),
        ...(seed ? { seed } : {}),
        participants: [
          { botId: redBot, version: rv, team: "red" },
          { botId: blueBot, version: bv, team: "blue" },
        ],
      });
      setCreated(battle.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <section>
        <h2>Batalla encolada</h2>
        <p className="ok">
          Batalla <code>{created}</code> creada y encolada.
        </p>

        <h3>Ejecución real (containerizada)</h3>
        {runResult ? (
          <p className="ok" role="status">
            Ejecución: <strong>{runResult.status}</strong>
            {runResult.replay?.ingested ? (
              <>
                {" · replay ingerido · "}
                <a href={`#/replay/${encodeURIComponent(created)}`}>ver replay</a>
              </>
            ) : null}
          </p>
        ) : (
          <>
            <button data-testid="run-real" disabled={!runCap.available || running} onClick={() => runReal(created)}>
              {running ? "Ejecutando…" : "Ejecutar batalla real"}
            </button>
            {!runCap.available && (
              <p className="warn" role="note">
                Ejecución real no disponible en este entorno
                {runCap.enabled ? " (runner no configurado)." : " (deshabilitada)."}
              </p>
            )}
            {runErr && (
              <p className="error" role="alert">
                {runErr}
              </p>
            )}
          </>
        )}

        <p>
          <a href="#/battles">Ver batallas</a> · <a href="#/replays">Ver replays</a>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Nueva batalla de práctica</h2>
      <p className="warn" role="note">
        La batalla se <strong>encola</strong> y la ejecuta el worker de la plataforma; el límite de ticks lo fija el
        ruleset. La ejecución con <strong>runner containerizado</strong> (código no confiable aislado) NO está
        disponible desde la UI: es un flujo operativo opt-in (arnés <code>e2e-real-battle-smoke</code>).
      </p>
      {loadErr && (
        <p role="alert" className="error">
          No se pudieron cargar mapas/bots: {loadErr}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <label>
        Modo{" "}
        <select aria-label="modo" value={mode} onChange={(e) => setMode(e.target.value)}>
          {Object.keys(MODE_RULESET).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        Mapa publicado{" "}
        <select aria-label="mapa" value={mapId} onChange={(e) => setMapId(e.target.value)}>
          <option value="">— elige —</option>
          {maps.map((m) => (
            <option key={`${m.mapId}@${m.version}`} value={m.mapId}>
              {m.mapId} v{m.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        Semilla (opcional) <input aria-label="semilla" value={seed} onChange={(e) => setSeed(e.target.value)} />
      </label>
      <label>
        Bot rojo{" "}
        <select aria-label="bot rojo" value={redBot} onChange={(e) => setRedBot(e.target.value)}>
          <option value="">— elige —</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} (v{b.latestPublishedVersion})
            </option>
          ))}
        </select>
      </label>
      <label>
        Bot azul{" "}
        <select aria-label="bot azul" value={blueBot} onChange={(e) => setBlueBot(e.target.value)}>
          <option value="">— elige —</option>
          {bots.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} (v{b.latestPublishedVersion})
            </option>
          ))}
        </select>
      </label>

      <button disabled={submitting || notEnoughBots || notEnoughMaps} onClick={submit}>
        Crear batalla
      </button>
      {notEnoughBots && <p className="warn">Necesitas al menos 2 bots con versión publicada.</p>}
      {notEnoughMaps && <p className="warn">No hay mapas publicados disponibles.</p>}
    </section>
  );
}
