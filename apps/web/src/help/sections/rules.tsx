/**
 * EQ3 · Ayuda de MODOS, REGLAS, BATALLAS y DESEMPATES.
 *
 * Fuentes:
 *  - RULESETS (packages/game-rules): tiempo, puntos, respawn y parámetros por modo;
 *  - MODE_REGISTRY (apps/arena-engine/src/sim/modes.ts): equipos, respawn exigido,
 *    requisitos del mapa y desempate al agotar el tiempo;
 *  - GET /rulesets (tabla `rulesets` de ESTA instalación, misma origen, sin Internet):
 *    qué rulesets ofrece la plataforma y a qué reglas del motor apuntan. Si la API no
 *    responde, la ayuda se sigue leyendo entera; sólo esa tabla dice que no está.
 *
 * La SEMÁNTICA (qué puntúa, cuándo termina) está auditada en modes.ts (motor 0.3.0)
 * y escrita aquí; los tests eq3-help-rules la ejecutan contra el motor real para
 * que el texto no se quede atrás del código.
 */
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api.js";
import { MODE_NAME, modeName } from "../../battle-result.js";
import { ENGINE_RULESETS, MODES, PLATFORM_MODES, RULE_CONSTANTS as C, VERSIONS } from "../sources.js";
import { ENGINE_ONLY_MODE_NAME, TIEBREAK_NAME, humanize } from "../names.js";
import { Note, Pending } from "../blocks.js";
import { InfoTip } from "../InfoTip.js";
import { helpHref } from "../tree.js";
import type { Ruleset } from "../../../../../packages/game-rules/index.js";

// ------------------------------------------------------------ utilidades
export const ticksToSeconds = (t: number) => t / C.TICK_HZ;
function secs(t: number): string {
  const s = ticksToSeconds(t);
  if (s >= 60 && s % 60 === 0) return `${s / 60} min`;
  return `${Math.round(s * 10) / 10} s`;
}

export function anyModeName(mode: string): string {
  return MODE_NAME[mode] ? modeName(mode) : humanize(ENGINE_ONLY_MODE_NAME, mode);
}

export const isPlatformMode = (m: string) => (PLATFORM_MODES as readonly string[]).includes(m);

export function rulesetsOfMode(mode: string): Ruleset[] {
  return Object.values(ENGINE_RULESETS).filter((r) => r.mode === mode);
}

/** Texto del respawn de un ruleset, con la cifra real. */
export function respawnText(r: Ruleset): string {
  if (!r.respawn.enabled) return "sin reaparición";
  const max = (r.respawn as { maxRespawns?: number }).maxRespawns;
  const base = `reaparición a los ${secs(r.respawn.delayTicks)} (${r.respawn.delayTicks} ticks)`;
  return max === undefined ? `${base}, ilimitada` : `${base}, como máximo ${max} por vehículo`;
}

/** Criterios de desempate de PR #201 (`timeoutTiebreak`), si el ruleset los trae. Hoy (main) ninguno. */
const TIMEOUT_CRITERION_NAME: Record<string, string> = {
  score: "más puntos",
  lives: "más vidas en juego",
  hull: "más integridad de casco",
};

/** Desempate al agotar el tiempo de un ruleset, desde el registro de modos (o el campo nuevo si existe). */
export function tiebreakText(r: Ruleset): string {
  const explicit = (r as { timeoutTiebreak?: string[] }).timeoutTiebreak;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return `${explicit.map((c) => humanize(TIMEOUT_CRITERION_NAME, c)).join("; después, ")}; si todo empata, empate`;
  }
  const meta = MODES[r.mode];
  return humanize(TIEBREAK_NAME, meta?.tiebreak ?? "draw");
}

// ------------------------------------------ rulesets de la instalación
export interface PlatformRuleset {
  id: string;
  name: string;
  mode: string | null;
  engineRulesetId: string | null;
  budgetCredits: number;
  forbiddenCategories?: string[];
}

type Remote = { state: "loading" } | { state: "ok"; items: PlatformRuleset[] } | { state: "unavailable"; why: string };

/** GET /rulesets (público, mismo origen). Nunca bloquea la ayuda: si falla, se dice y ya. */
export function usePlatformRulesets(): Remote {
  const [r, setR] = useState<Remote>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    api<{ items: PlatformRuleset[] }>("GET", "/rulesets", undefined, { timeoutMs: 5000 })
      .then((body) => alive && setR({ state: "ok", items: Array.isArray(body?.items) ? body.items : [] }))
      .catch((e) => alive && setR({ state: "unavailable", why: (e as Error)?.message ?? "sin respuesta" }));
    return () => {
      alive = false;
    };
  }, []);
  return r;
}

function PlatformRulesets(props: { mode?: string }) {
  const remote = usePlatformRulesets();
  if (remote.state === "loading")
    return (
      <p role="status" data-testid="help-platform-rulesets-loading">
        Consultando los rulesets de esta instalación…
      </p>
    );
  if (remote.state === "unavailable")
    return (
      <p className="warn" data-testid="help-platform-rulesets-unavailable">
        No se han podido consultar los rulesets de esta instalación ({remote.why}). El resto de la ayuda no depende de
        ello.
      </p>
    );
  const items = remote.items.filter((x) => !props.mode || x.mode === null || x.mode === props.mode);
  return (
    <table className="stack-table" data-testid="help-platform-rulesets">
      <caption>Rulesets que ofrece esta instalación al crear una batalla</caption>
      <thead>
        <tr>
          <th scope="col">Ruleset</th>
          <th scope="col">Modo</th>
          <th scope="col">Reglas del motor</th>
          <th scope="col">Presupuesto</th>
        </tr>
      </thead>
      <tbody>
        {items.map((x) => (
          <tr key={x.id}>
            <td data-label="Ruleset">
              {x.name} <code>{x.id}</code>
            </td>
            <td data-label="Modo">{x.mode ? anyModeName(x.mode) : "cualquiera"}</td>
            <td data-label="Reglas del motor">
              {x.engineRulesetId ? <code>{x.engineRulesetId}</code> : "las por defecto del modo elegido"}
            </td>
            <td data-label="Presupuesto">{x.budgetCredits} créditos</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// --------------------------------------------- tabla de reglas del motor
export function EngineRulesetTable(props: { mode?: string; testId?: string }) {
  const list = props.mode ? rulesetsOfMode(props.mode) : Object.values(ENGINE_RULESETS);
  return (
    <table className="stack-table stack-table--wide" data-testid={props.testId ?? "help-engine-rulesets"}>
      <caption>Reglas del motor {VERSIONS.engine} (packages/game-rules)</caption>
      <thead>
        <tr>
          <th scope="col">Id</th>
          <th scope="col">Modo</th>
          <th scope="col">Duración</th>
          <th scope="col">Para ganar</th>
          <th scope="col">Respawn</th>
          <th scope="col">Fuego amigo</th>
          <th scope="col">Desempate al acabar el tiempo</th>
          <th scope="col">Modo en la plataforma</th>
        </tr>
      </thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.rulesetId} data-testid={`help-ruleset-${r.rulesetId}`}>
            <td data-label="Id">
              <code>{r.rulesetId}</code>
            </td>
            <td data-label="Modo">{anyModeName(r.mode)}</td>
            <td data-label="Duración">
              {secs(r.timeLimitTicks)} ({r.timeLimitTicks} ticks)
            </td>
            <td data-label="Para ganar">
              {r.scoreToWin >= Number.MAX_SAFE_INTEGER ? "no aplica (eliminación)" : `${r.scoreToWin} puntos`}
              {r.match ? ` · al mejor de ${r.match.rounds} rondas` : ""}
            </td>
            <td data-label="Respawn">{respawnText(r)}</td>
            <td data-label="Fuego amigo">{r.friendlyFire ? "sí" : "no"}</td>
            <td data-label="Desempate al acabar el tiempo">{tiebreakText(r)}</td>
            <td data-label="Modo en la plataforma">{isPlatformMode(r.mode) ? "sí" : "no (sólo motor)"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ModeRequirements(props: { mode: string }) {
  const m = MODES[props.mode];
  if (!m) return null;
  const teams =
    m.maxTeams === Number.POSITIVE_INFINITY
      ? `${m.minTeams} o más`
      : m.minTeams === m.maxTeams
        ? `exactamente ${m.minTeams}`
        : `${m.minTeams} a ${m.maxTeams}`;
  const resp = { required: "obligatorio", forbidden: "prohibido", any: "opcional (lo decide el ruleset)" }[m.respawn];
  const needs: string[] = [];
  if (m.requires.flagsAndBases) needs.push("una bandera y una base por equipo");
  if (m.requires.captureZones) needs.push(`al menos ${m.requires.captureZones} zona(s) de captura`);
  return (
    <ul data-testid={`help-mode-reqs-${props.mode}`}>
      <li>Bandos: {teams}.</li>
      <li>Respawn: {resp}.</li>
      <li>Mapa: {needs.length ? needs.join(" y ") : "puntos de aparición (sin objetos especiales)"}.</li>
      <li>Al acabar el tiempo: {humanize(TIEBREAK_NAME, m.tiebreak)}.</li>
    </ul>
  );
}

/** Condiciones de fin comunes (BaseMode.winner del motor 0.3.0), en el orden en que se comprueban. */
function CommonEnd() {
  return (
    <ol data-testid="help-common-end">
      <li>Si un equipo llega a los puntos para ganar, gana.</li>
      <li>
        Si se acaba el tiempo, gana el que tenga más puntos; si los dos primeros empatan, la batalla acaba en empate.
      </li>
      <li>
        Si el ruleset no tiene reaparición y sólo queda un equipo con vehículos vivos, gana ese equipo; si no queda
        nadie, empate.
      </li>
    </ol>
  );
}

function ModePage(props: { mode: string; children: ReactNode }) {
  const platform = isPlatformMode(props.mode);
  return (
    <div data-testid={`help-mode-${props.mode}`}>
      <p>
        <strong>{anyModeName(props.mode)}</strong> <code>{props.mode}</code>
        {platform ? " · disponible al crear batallas." : " · sólo existe en el motor: la plataforma aún no lo ofrece."}
      </p>
      {props.children}
      <h4>Requisitos (registro de modos del motor)</h4>
      <ModeRequirements mode={props.mode} />
      <h4>Reglas</h4>
      <EngineRulesetTable mode={props.mode} testId={`help-mode-rulesets-${props.mode}`} />
      {platform && <PlatformRulesets mode={props.mode} />}
    </div>
  );
}

// ------------------------------------------------------------------ modos
export function ModeDeathmatch() {
  return (
    <ModePage mode="deathmatch">
      <p>Todos contra todos: cada vehículo juega por su cuenta (es su propio bando).</p>
      <ul>
        <li>Destruir a otro vehículo da 1 punto a quien lo destruye.</li>
        <li>Un derribo sin autor (daño del mapa) o propio no da puntos a nadie.</li>
        <li>La plataforma rechaza una batalla de este modo con dos vehículos en el mismo bando.</li>
      </ul>
      <h4>Cómo termina</h4>
      <CommonEnd />
    </ModePage>
  );
}

export function ModeTeamDeathmatch() {
  return (
    <ModePage mode="team_deathmatch">
      <p>Por bandos: cada derribo de un rival suma 1 punto a tu bando.</p>
      <ul>
        <li>
          Con fuego amigo activo, destruir a un compañero da 1 punto a cada bando rival (ningún ruleset actual lo
          activa).
        </li>
      </ul>
      <h4>Cómo termina</h4>
      <CommonEnd />
    </ModePage>
  );
}

export function ModeCaptureTheFlag() {
  const rs = rulesetsOfMode("capture_the_flag")[0];
  return (
    <ModePage mode="capture_the_flag">
      <ul data-testid="help-ctf-rules">
        <li>Coges la bandera rival al acercarte a 2 m o menos de ella. Un vehículo lleva como mucho una bandera.</li>
        <li>Si quien la lleva es destruido o descalificado, la bandera cae donde estaba.</li>
        <li>
          Una bandera caída vuelve sola a su base pasados {rs ? `${secs(rs.ctf!.flagReturnTicks)}` : "unos segundos"}{" "}
          (flagReturnTicks), o al instante si la toca un vehículo de su equipo.
        </li>
        <li>
          Capturas al entrar en TU base con la bandera rival: +1 punto, y esa bandera vuelve a su base.
          {rs?.ctf?.requireOwnFlagAtBase
            ? " Con las reglas actuales sólo puedes capturar si tu propia bandera está en tu base."
            : ""}
        </li>
        <li>
          La posición de una bandera es pública sólo cuando está en su base; llevada o caída, hay que verla con los
          sensores.
        </li>
      </ul>
      <h4>Cómo termina</h4>
      <CommonEnd />
    </ModePage>
  );
}

/** Semántica EXACTA de zone_control (ZoneControlMode, motor 0.3.0). La comprueba eq3-help-rules contra el motor. */
export const ZONE_CONTROL_RULES: { id: string; text: string }[] = [
  {
    id: "solo",
    text: "Si UN único bando tiene vehículos dentro de una zona de captura, ese bando la controla y puntúa en cada tick mientras siga solo dentro.",
  },
  {
    id: "disputada",
    text: "Si hay vehículos de dos o más bandos dentro, la zona está disputada: no puntúa nadie y no cambia de dueño.",
  },
  {
    id: "vacia",
    text: "Si queda vacía, no puntúa nadie (tampoco quien la controló). Sigue mostrándose con el último bando que la tomó, pero sin presencia no da puntos.",
  },
  {
    id: "presencia",
    text: "«Estar dentro» es tener el centro del vehículo, vivo y no descalificado, a una distancia del centro de la zona menor o igual que su radio. Una zona rectangular o poligonal cuenta como el círculo inscrito en ella.",
  },
  {
    id: "varias",
    text: "Cada zona puntúa por separado: un bando solo en dos zonas suma el doble por tick.",
  },
  {
    id: "instantanea",
    text: "No hay tiempo de captura: entrar solo ya controla y puntúa ese mismo tick (captureTimeTicks del mapa no lo usa el motor).",
  },
];

export function ModeZoneControl() {
  const rs = rulesetsOfMode("zone_control");
  const zc = rs.find((r) => r.rulesetId === "zc_mvp@1") ?? rs[0];
  const pts = zc?.zone?.pointsPerTickHeld ?? 1;
  return (
    <ModePage mode="zone_control">
      <p>Hay que ocupar las zonas de captura del mapa. Sólo cuentan las zonas de tipo captura (no las de daño).</p>
      <ul data-testid="help-zone-control-rules">
        {ZONE_CONTROL_RULES.map((r) => (
          <li key={r.id} data-rule={r.id}>
            {r.text}
          </li>
        ))}
      </ul>
      {zc && (
        <p>
          Con <code>{zc.rulesetId}</code>: {pts} punto por tick y zona ({pts * C.TICK_HZ} por segundo); para ganar hacen
          falta {zc.scoreToWin} puntos, unos {secs(Math.ceil(zc.scoreToWin / pts))} solo en una zona.
        </p>
      )}
      <h4>Control de zona no es Dominación</h4>
      <p data-testid="help-zc-vs-domination">
        En <strong>Dominación</strong> (<code>domination</code>, sólo en el motor) la zona sigue siendo tuya y puntuando
        aunque la abandones, hasta que otro bando entre SOLO en ella; necesita al menos 2 zonas. En{" "}
        <strong>Control de zona</strong> sin presencia no se puntúa nunca. «King of the Hill» (<code>koth_mvp@1</code>,
        sólo motor) es Control de zona con una sola zona y 100 puntos para ganar.
      </p>
      <h4>Cómo termina</h4>
      <CommonEnd />
    </ModePage>
  );
}

export function ModeElimination() {
  return (
    <div data-testid="help-mode-elimination">
      <p>Hoy no hay un modo «Eliminación» propio en la plataforma. Lo más parecido que existe en este código:</p>
      <ul>
        <li>
          Los rulesets <strong>sin reaparición</strong> (por ejemplo <code>dm_practice@1</code>, el de Deathmatch de
          práctica): si sólo queda un bando con vehículos vivos, gana; ver{" "}
          <a href={helpHref("batallas", "puntuacion")}>Puntuación</a>.
        </li>
        <li>
          <strong>Último en pie</strong> (<code>last_man_standing</code>, sólo motor): sin reaparición, gana la ronda el
          último bando con vivos, al mejor de 3 rondas con cambio de lado; al acabar el tiempo gana quien tenga más
          vivos y, si empatan, más derribos.
        </li>
      </ul>
      <Pending testId="help-pending-elimination">
        El preset oficial «Eliminación» lo está cerrando el equipo de reglas (PR #201, aún no está en esta versión).
        Cuando se integre, esta página mostrará sus reglas reales.
      </Pending>
    </div>
  );
}

export function ModeLimitedRespawn() {
  return (
    <div data-testid="help-mode-limited-respawn">
      <p>
        En esta versión la reaparición es <strong>ilimitada</strong> o <strong>no existe</strong>: un ruleset no puede
        limitar el número de reapariciones.
      </p>
      <Pending testId="help-pending-limited-respawn">
        El «Respawn limitado» (número máximo de reapariciones por vehículo) llega con el PR #201 del equipo de reglas.
        Si un ruleset trae ese límite, las tablas de reglas de esta ayuda ya lo muestran («como máximo N por vehículo»).
      </Pending>
    </div>
  );
}

export function ModeOthers() {
  const engineOnly = Object.keys(MODES).filter((m) => !isPlatformMode(m));
  return (
    <div data-testid="help-mode-others">
      <p>
        Estos modos y presets existen en el motor ({VERSIONS.engine}) pero la plataforma aún no los ofrece al crear
        batallas (la API responde «mode inválido»):
      </p>
      <ul>
        {engineOnly.map((m) => (
          <li key={m}>
            <strong>{anyModeName(m)}</strong> <code>{m}</code>
          </li>
        ))}
      </ul>
      <ul>
        <li>
          <strong>Dominación</strong>: varias zonas; entrar solo en una la hace tuya y la propiedad sigue puntuando
          aunque te vayas (puntos por tick × zonas en propiedad).
        </li>
        <li>
          <strong>Juggernaut</strong>: un vehículo marcado; destruirlo da 3 puntos y pasa la marca al bando que lo
          destruyó; los derribos del bando del marcado dan 1 punto. Exige reaparición.
        </li>
        <li>
          <strong>Último en pie</strong>: ver <a href={helpHref("modos", "eliminacion")}>Eliminación</a>.
        </li>
      </ul>
      <EngineRulesetTable testId="help-engine-rulesets-all" />
    </div>
  );
}

// --------------------------------------------------------------- batallas
export function BattleNew() {
  return (
    <div data-testid="help-battle-new">
      <p>
        «Batallas» → «+ Nueva batalla de práctica». Las batallas de práctica <strong>no cambian el rating</strong>.
      </p>
      <ol>
        <li>
          <strong>Tipo</strong>: batalla individual (un bot por bando) o por equipos (hasta 4 por bando).
        </li>
        <li>
          <strong>Modo</strong>{" "}
          <InfoTip topic="Modo" helpHref={helpHref("modos", "deathmatch")} testId="tip-mode">
            Las reglas de victoria: {PLATFORM_MODES.map((m) => anyModeName(m)).join(", ")}.
          </InfoTip>{" "}
          y <strong>ruleset</strong> (las reglas concretas: duración, puntos, presupuesto).
        </li>
        <li>
          <strong>Mapa publicado</strong>: sólo aparecen los que declaran el modo elegido.
        </li>
        <li>
          <strong>Semilla</strong> (opcional): el motor es determinista; con la misma semilla, mapa, reglas y órdenes de
          los bots, la batalla se repite igual.
        </li>
        <li>
          <strong>Bots</strong>: en cada bando, un bot y una versión <strong>publicada y elegible</strong>. Puedes usar
          tus bots, bots públicos y bots de tus equipos. Un mismo bot no puede ir dos veces.
        </li>
      </ol>
      <p>Al crearla queda en cola; la plataforma la juega una sola vez y luego puedes verla en directo o en replay.</p>
    </div>
  );
}

export function Battle1v1() {
  return (
    <div data-testid="help-battle-1v1">
      <p>
        Una batalla individual enfrenta a un bot del bando rojo con uno del azul. El <strong>bando</strong> es sólo el
        lado del campo, no un equipo de la sección «Equipos»: dos bots del mismo equipo pueden enfrentarse.
      </p>
      <p>
        Vale para cualquier modo disponible. En Captura la bandera y Control de zona el mapa necesita además sus
        banderas y bases o sus zonas.
      </p>
    </div>
  );
}

export function BattleTeams() {
  return (
    <div data-testid="help-battle-teams">
      <p>
        En una batalla por equipos eliges Equipo A (bando rojo) y Equipo B (bando azul) entre los equipos de los que
        eres miembro; sus bots elegibles se cargan solos y puedes excluirlos o sustituirlos.
      </p>
      <ul>
        <li>Exactamente 2 bandos, de 1 a 4 bots cada uno (8 como máximo).</li>
        <li>
          Modos de equipo: {["team_deathmatch", "capture_the_flag", "zone_control"].map(anyModeName).join(", ")}. En
          Deathmatch cada vehículo es su propio bando.
        </li>
        <li>El resultado se da por bando; cada bot juega su versión publicada.</li>
      </ul>
    </div>
  );
}

export function BattleRespawns() {
  return (
    <div data-testid="help-battle-respawns">
      <p>
        Lo decide el ruleset: con reaparición, un vehículo destruido vuelve tras el retardo en un punto de aparición
        libre de su bando, elegido de forma determinista; mientras tanto <code>observation.self.respawningInTicks</code>{" "}
        dice cuánto falta. Sin reaparición, el vehículo queda fuera hasta el final.
      </p>
      <p>Algunos modos lo imponen: Juggernaut exige reaparición y Último en pie la prohíbe.</p>
      <table className="stack-table" data-testid="help-respawn-table">
        <caption>Respawn por ruleset</caption>
        <thead>
          <tr>
            <th scope="col">Ruleset</th>
            <th scope="col">Respawn</th>
          </tr>
        </thead>
        <tbody>
          {Object.values(ENGINE_RULESETS).map((r) => (
            <tr key={r.rulesetId}>
              <td data-label="Ruleset">
                <code>{r.rulesetId}</code> ({anyModeName(r.mode)})
              </td>
              <td data-label="Respawn">{respawnText(r)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Note>
        Respawn limitado (número máximo de reapariciones): <a href={helpHref("modos", "respawn-limitado")}>pendiente</a>
        .
      </Note>
    </div>
  );
}

export function BattleScoring() {
  return (
    <div data-testid="help-battle-scoring">
      <table className="stack-table" data-testid="help-scoring-table">
        <caption>Qué da puntos en cada modo</caption>
        <thead>
          <tr>
            <th scope="col">Modo</th>
            <th scope="col">Puntos</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-label="Modo">{anyModeName("deathmatch")}</td>
            <td data-label="Puntos">1 por vehículo rival destruido.</td>
          </tr>
          <tr>
            <td data-label="Modo">{anyModeName("team_deathmatch")}</td>
            <td data-label="Puntos">1 para el bando por cada rival destruido.</td>
          </tr>
          <tr>
            <td data-label="Modo">{anyModeName("capture_the_flag")}</td>
            <td data-label="Puntos">1 por captura.</td>
          </tr>
          <tr>
            <td data-label="Modo">{anyModeName("zone_control")}</td>
            <td data-label="Puntos">Por cada tick y zona en la que tu bando está SOLO.</td>
          </tr>
        </tbody>
      </table>
      <h4>Cómo termina una batalla</h4>
      <CommonEnd />
      <p>
        El marcador de cada bando está en <code>observation.score</code>.
      </p>
    </div>
  );
}

export function BattleTiebreaks() {
  return (
    <div data-testid="help-battle-tiebreaks">
      <p>
        Qué pasa si se acaba el tiempo sin que nadie haya alcanzado los puntos para ganar (motor {VERSIONS.engine}):
      </p>
      <ul data-testid="help-tiebreak-modes">
        {Object.entries(MODES).map(([id, m]) => (
          <li key={id}>
            <strong>{anyModeName(id)}</strong>: {humanize(TIEBREAK_NAME, m.tiebreak)}.
            {!isPlatformMode(id) && " (sólo motor)"}
          </li>
        ))}
      </ul>
      <p>«Empate» significa que la batalla termina sin ganador: cuenta como empate (la E de V-D-E) en los torneos.</p>
      <Pending testId="help-pending-tiebreaks">
        El equipo de reglas está cerrando desempates nuevos (vidas en juego, integridad del casco) en el PR #201, que
        aún no está en esta versión. Esta página no los da por hechos: cuando un ruleset los traiga, la tabla de{" "}
        <a href={helpHref("referencia", "reglas")}>Reglas</a> los mostrará en su columna de desempate.
      </Pending>
    </div>
  );
}

export function RulesReference() {
  return (
    <div data-testid="help-rules-reference">
      <EngineRulesetTable testId="help-engine-rulesets-ref" />
      <PlatformRulesets />
      <h4>Constantes de la simulación</h4>
      <ul>
        <li>
          {C.TICK_HZ} ticks por segundo; decisión cada {C.DECISION_EVERY_N_TICKS} ticks; plazo de respuesta{" "}
          {C.DECISION_DEADLINE_MS} ms.
        </li>
        <li>
          Arena por defecto de {C.ARENA_MVP_WIDTH_M} × {C.ARENA_MVP_HEIGHT_M} m; todo mapa tiene perímetro (no se sale
          del borde).
        </li>
        <li>
          Desconexión: {C.DISCONNECT_GRACE_TICKS} ticks de gracia; {C.MAX_CONSECUTIVE_TIMEOUTS} turnos sin responder
          seguidos descalifican.
        </li>
      </ul>
    </div>
  );
}

/** ⓘ listo para el selector de modo (EQ2/EQ4): explicación corta + enlace a la página del modo. */
export function ModeHelpTip(props: { mode: string }) {
  const short: Record<string, string> = {
    deathmatch: "Todos contra todos: 1 punto por vehículo rival destruido.",
    team_deathmatch: "Por bandos: 1 punto para tu bando por cada rival destruido.",
    capture_the_flag: "Lleva la bandera rival a tu base: 1 punto por captura.",
    zone_control: "Puntúa el bando que está SOLO dentro de una zona de captura. Disputada o vacía, no puntúa nadie.",
  };
  const m = MODES[props.mode];
  return (
    <InfoTip topic={anyModeName(props.mode)} helpHref={helpHref("modos", props.mode)} testId={`tip-mode-${props.mode}`}>
      {short[props.mode] ?? "Modo del motor."} {m ? `Al acabar el tiempo: ${humanize(TIEBREAK_NAME, m.tiebreak)}.` : ""}
    </InfoTip>
  );
}
