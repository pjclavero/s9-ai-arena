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
 *
 * FC-C (TD-003) · los modos y los rulesets salen de la API (GET /rulesets: ids REALES
 * de la tabla `rulesets`); aquí no hay ningún id de ruleset. Los mapas se filtran por
 * el modo elegido (supportedModes) y cada bando puede tomar sus bots de un equipo.
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";

export interface RulesetOption {
  id: string;
  name: string;
  mode: string | null;
  budgetCredits: number;
}
interface TeamOption {
  id: string;
  name: string;
  isMember?: boolean;
  bots?: { id: string; name: string }[];
}

interface MapVersion {
  mapId: string;
  name?: string;
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
  const [modes, setModes] = useState<string[]>([]);
  const [rulesets, setRulesets] = useState<RulesetOption[]>([]);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [mode, setMode] = useState("");
  const [rulesetId, setRulesetId] = useState("");
  const [redTeam, setRedTeam] = useState("");
  const [blueTeam, setBlueTeam] = useState("");
  const [mapKey, setMapKey] = useState(""); // `${mapId}@${version}`
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
        const [m, b, r, t] = await Promise.all([
          api<{ items: MapVersion[] }>("GET", "/maps?limit=100"),
          api<{ items: BotSummary[] }>("GET", "/bots?limit=100"),
          api<{ modes: string[]; items: RulesetOption[] }>("GET", "/rulesets"),
          api<{ items: TeamOption[] }>("GET", "/teams?limit=100"),
        ]);
        setMaps((m.items ?? []).filter((x) => x.state === "published"));
        setBots((b.items ?? []).filter((x) => x.latestPublishedVersion != null));
        setModes(r.modes ?? []);
        setRulesets(r.items ?? []);
        setTeams((t.items ?? []).filter((x) => x.isMember));
        if (r.modes?.length) setMode(r.modes[0]);
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
  // Opciones REALES derivadas del modo elegido.
  const modeRulesets = rulesets.filter((r) => r.mode === mode || r.mode === null);
  const modeMaps = maps.filter((m) => (m.supportedModes ?? []).includes(mode));
  const selectedMap = modeMaps.find((m) => `${m.mapId}@${m.version}` === mapKey);
  const effectiveRuleset = modeRulesets.some((r) => r.id === rulesetId)
    ? rulesetId
    : ((modeRulesets.find((r) => r.mode === mode) ?? modeRulesets[0])?.id ?? "");
  const botsOf = (teamId: string) => {
    if (!teamId) return bots;
    const ids = new Set((teams.find((t) => t.id === teamId)?.bots ?? []).map((x) => x.id));
    return bots.filter((x) => ids.has(x.id));
  };

  const notEnoughBots = bots.length < 2;
  const notEnoughMaps = modeMaps.length < 1;

  async function submit() {
    setError("");
    if (!effectiveRuleset) return setError("No hay ningún ruleset para este modo.");
    if (!selectedMap) return setError("Elige un mapa publicado que soporte el modo.");
    if (!redBot || !blueBot) return setError("Elige dos bots con versión publicada.");
    if (redBot === blueBot) return setError("Elige dos bots distintos.");
    const rv = botVersion(redBot);
    const bv = botVersion(blueBot);
    if (rv == null || bv == null) return setError("Los bots elegidos no tienen versión publicada.");
    setSubmitting(true);
    try {
      const battle = await api<{ id: string }>("POST", "/battles", {
        mode,
        rulesetId: effectiveRuleset, // id de la tabla `rulesets`, servido por GET /rulesets
        mapId: selectedMap.mapId,
        mapVersion: selectedMap.version,
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
        <select
          aria-label="modo"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            setMapKey("");
            setRulesetId("");
          }}
        >
          {modes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        Ruleset{" "}
        <select aria-label="ruleset" value={effectiveRuleset} onChange={(e) => setRulesetId(e.target.value)}>
          {modeRulesets.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.id}, {r.budgetCredits} cr)
            </option>
          ))}
        </select>
      </label>
      <label>
        Mapa publicado{" "}
        <select aria-label="mapa" value={mapKey} onChange={(e) => setMapKey(e.target.value)}>
          <option value="">— elige —</option>
          {modeMaps.map((m) => (
            <option key={`${m.mapId}@${m.version}`} value={`${m.mapId}@${m.version}`}>
              {m.name ? `${m.name} · ` : ""}
              {m.mapId} v{m.version}
            </option>
          ))}
        </select>
      </label>
      <label>
        Semilla (opcional) <input aria-label="semilla" value={seed} onChange={(e) => setSeed(e.target.value)} />
      </label>
      {teams.length > 0 && (
        <label>
          Equipo rojo (opcional){" "}
          <select
            aria-label="equipo rojo"
            value={redTeam}
            onChange={(e) => {
              setRedTeam(e.target.value);
              setRedBot("");
            }}
          >
            <option value="">— cualquiera —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Bot rojo{" "}
        <select aria-label="bot rojo" value={redBot} onChange={(e) => setRedBot(e.target.value)}>
          <option value="">— elige —</option>
          {botsOf(redTeam).map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} (v{b.latestPublishedVersion})
            </option>
          ))}
        </select>
      </label>
      {teams.length > 0 && (
        <label>
          Equipo azul (opcional){" "}
          <select
            aria-label="equipo azul"
            value={blueTeam}
            onChange={(e) => {
              setBlueTeam(e.target.value);
              setBlueBot("");
            }}
          >
            <option value="">— cualquiera —</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Bot azul{" "}
        <select aria-label="bot azul" value={blueBot} onChange={(e) => setBlueBot(e.target.value)}>
          <option value="">— elige —</option>
          {botsOf(blueTeam).map((b) => (
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
      {notEnoughMaps && <p className="warn">No hay mapas publicados que soporten el modo {mode}.</p>}
    </section>
  );
}
