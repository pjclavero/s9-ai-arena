/**
 * B2 · Launcher REAL de `BattleRunLauncher` (apps/api/src/battle-run.ts): habla
 * por HTTP con el servicio arena-engine (`POST /run`, apps/arena-engine/src/service.ts),
 * NUNCA con Docker directamente. Cadena completa:
 *
 *   API --HTTP(red platform)--> arena-engine --HTTP--> s9-docker-proxy --> bots (red arena)
 *
 * Traduce `BattleRunInput` (contrato de la API, cap. 16) al cuerpo que espera
 * `POST /run` de arena-engine y traduce la respuesta de vuelta a `BattleRunResult`.
 * Autenticación interna: el mismo secreto compartido que arena-engine exige
 * (cabecera `x-arena-engine-auth`); NUNCA se loguea ni se devuelve en respuestas.
 *
 * `S9_ENABLE_REAL_BATTLE_RUNS` sigue apagada por defecto (battle-run.ts): este
 * fichero solo aporta el launcher, no enciende nada. Wiring en server.ts:
 * se inyecta cuando `ARENA_ENGINE_URL` + el secreto están AMBOS presentes;
 * si falta alguno, no se inyecta runner y `/battles/:id/run` sigue en 503
 * `runner_unavailable` con la flag encendida (fail closed, igual que hoy).
 *
 * MAPA — B9 · CUALQUIER MAPA PUBLICADO, RESUELTO DE VERDAD (antes: solo
 * `mvp-arena-01` v1).
 *
 * B2 dejó una allowlist rígida (`FIXTURE_MAP_EQUIVALENTS`) que traducía el
 * único mapId conocido a un MAPA-FIXTURE del motor ("empty"|"mvp"|"ctf",
 * `apps/arena-engine/src/fixtures.ts`), porque `/run` solo aceptaba un nombre
 * de fixture. Rechazar el resto era lo correcto (mejor eso que jugar otro mapa
 * en silencio), pero dejaba sin usar el catálogo real de mapas del proyecto y
 * hacía que ni siquiera `mvp-arena-01` se jugara con su geometría real: se
 * jugaba la fixture equivalente, "PROVISIONAL POR DISEÑO" según su propio
 * comentario.
 *
 * B9 quita la allowlist y resuelve el mapa contra el CATÁLOGO
 * (`services/battle-map-resolver.ts`): `map_versions` publicado →
 * `toEngineMap()` → `ArenaMap`, que ahora viaja en el cuerpo de `POST /run`
 * (campo `map`, validado en el otro extremo con `validateArenaMap()`). El
 * invariante NO cambia — se refuerza: si el mapa no existe, no está publicado,
 * su documento no cuadra con la fila que lo indexa, su checksum canónico no
 * verifica, no pasa el validador de E4 o no es jugable, la batalla se rechaza
 * (`status: "failed"` + `errorCode` distinguible) SIN llamar a arena-engine.
 * Y al volver, se comprueba que el mapa de la cabecera del replay es
 * EXACTAMENTE el pedido — el mapa ENTERO, geometría incluida (`sameArenaMap`),
 * no solo su etiqueta: el `checksum` de un `ArenaMap` viene copiado del
 * documento origen y no se deriva de la geometría, así que comparar etiquetas
 * dejaba pasar una batalla jugada en otro mapa con la firma del pedido
 * (bloqueante del supervisor de B9, demostrado con una batalla real). Si el
 * motor jugó otro mapa: `failed` y sin ingestar.
 *
 * RULESET/TICKS — B9 · también resueltos (era el otro límite conocido de B2, y
 * además estaba ROTO): el launcher enviaba `rulesetId: input.mode`
 * ("deathmatch"), que no es un ruleset del motor (`dm_practice@1`...), así que
 * `loadRuleset()` lanzaba dentro de `runContainerBattle` y toda batalla real
 * lanzada por la API terminaba en 502 genérico. Ahora
 * `services/battle-ruleset-resolver.ts` traduce modo+ruleset de BD → ruleset
 * REAL del motor (exigiendo que el modo coincida) y `ticks` sale de
 * `ruleset.timeLimitTicks` en vez de un 20000 inventado.
 *
 * B6 · INGESTA DEL REPLAY (cierra el circuito hasta el visor): arena-engine
 * devuelve `{ result, replay, postures }` (`ContainerBattleOutcome`, replay.ts
 * REAL del motor) en el cuerpo 200, pero hasta B6 este launcher lo descartaba
 * (`replay: { ingested: false, ... }` siempre) — el replay se perdía al volver
 * de `/run`, nunca llegaba al replay-service, y el visor web (que habla
 * DIRECTAMENTE con el replay-service vía el gateway, `apps/web/src/pages/
 * ReplayPage.tsx` → `/replays/:battleId/index|segment`, NO a través de esta
 * API) no tenía nada que reproducir.
 *
 * Cierre: si `cfg.replayServiceUrl` está configurado, este launcher:
 *   0. COMPRUEBA LA IDENTIDAD (hallazgo del supervisor de B6, ejecutado en
 *      vivo: un replay REAL, legítimo y perfectamente verificable, pero
 *      grabado para OTRA batalla, se ingestaba igual bajo el battleId pedido
 *      — un fallo de caché en arena-engine, o un arena-engine comprometido,
 *      bastaría para mostrar la batalla de alguien como si fuera la de otro).
 *      `replay.header.battleId` DEBE coincidir con `input.battleId` ANTES de
 *      verificar nada; si no coincide, se rechaza sin re-simular ni ingestar.
 *   1. VERIFICA el replay localmente y RECOMPUTA `events`/`snapshots`
 *      (`verifyAndRecompute()`, arena-engine/src/replay.ts — re-simula con el
 *      motor real) ANTES de ingestarlo. Un replay que no verifica NUNCA se
 *      envía al replay-service como si fuera bueno. Se refleja con
 *      `replay.verify_matches: false` y NO se llama al replay-service.
 *
 *      HALLAZGO DEL SUPERVISOR (ejecutado en vivo, no solo leído): `verify()`
 *      SOLO compara `stateHashes`/`finalStateHash` (recomputados desde
 *      `header`+`commands`) — NUNCA compara `events` ni `snapshots`, que es
 *      justo lo que el visor pinta directamente sin recomputar nada. El
 *      supervisor inyectó un evento falso y sobrescribió los snapshots con
 *      posiciones inventadas, dejando comandos y hashes intactos: `verify()`
 *      seguía devolviendo `matches: true`. Por eso este launcher usa
 *      `verifyAndRecompute()` y, al construir el JSONL que se ingesta, IGNORA
 *      `replay.events`/`replay.snapshots` recibidos por la red y usa SIEMPRE
 *      los recomputados por la re-simulación (igual que `stateHashes`/
 *      `result`) — lo que el espectador ve queda cubierto por la misma
 *      garantía criptográfica que el hash final. Ver la nota de cabecera de
 *      `verify()`/`verifyAndRecompute()` en replay.ts para el porqué no se
 *      resolvió ampliando `matches` en el propio motor (bajo riesgo elegido:
 *      cero cambios en el código de determinismo compartido).
 *   2. Si verifica y la identidad coincide, serializa a JSONL (mismo formato
 *      que graba el motor, `toJsonl`) el replay RECONSTRUIDO (header+commands
 *      originales, events/snapshots/stateHashes/result recomputados) y hace
 *      `POST /replays/:battleId` al replay-service (HTTP, misma red
 *      `platform` que ya comparten API y replay-service en
 *      infrastructure/docker-compose.yml — sin volumen compartido, sin tocar
 *      el filesystem del contenedor).
 *   3. Un fallo de ingesta (replay-service caído, timeout, respuesta != 201)
 *      es BEST-EFFORT por defecto (`replayIngestRequired: false`, igual
 *      decisión que el arnés E2E): la batalla en sí ya ocurrió y su resultado
 *      es válido aunque el replay tarde en aparecer en el visor; se refleja
 *      honestamente en `replay.ingested: false`, nunca se presenta como
 *      ingerido. Con `REPLAY_INGEST_REQUIRED=1` (modo estricto, mismo nombre
 *      de variable que el arnés E2E) un fallo de ingesta, un replay que no
 *      verifica O una identidad que no coincide hace que el `BattleRunResult`
 *      sea `status: "failed"`.
 *
 * Sin `cfg.replayServiceUrl` configurado, el comportamiento es EXACTAMENTE el
 * de B2: `replay: { ingested: false, battleId }`, sin `verify_matches`. OJO
 * (corrección del supervisor a la documentación anterior): esto NO es "opt-in"
 * en el sentido de "hay que activarlo a propósito" — `infrastructure/
 * docker-compose.yml` le da a `REPLAY_SERVICE_URL` un valor por defecto
 * (`http://replay-service:8083`) para el servicio `api`, así que en cualquier
 * despliegue con ese compose la ingesta está activa salvo que se sobrescriba
 * la variable a vacío explícitamente.
 */
import { readFileSync } from "node:fs";
import type { Db } from "../db/connection.js";
import { safeLookup } from "../../../../packages/game-rules/safe-lookup.js";
import { splitVersioned } from "../../../../packages/module-catalog/types.js";
import { toJsonl, verifyAndRecompute, type Replay } from "../../../arena-engine/src/replay.js";
import { REPLAY_INGEST_AUTH_HEADER, resolveIngestSecretFromEnv } from "../../../replay-service/src/auth.js";
import { arenaMapLabel, sameArenaMap } from "../../../arena-engine/src/arena-map.js";
import { runHttpTimeoutMs, theoreticalBattleMs } from "../../../../packages/game-rules/index.js";
import { modeMapIncompatibilities, type ArenaMap } from "../../../arena-engine/src/sim/modes.js";
import { resolveBattleMap } from "./battle-map-resolver.js";
import { resolveBattleRuleset } from "./battle-ruleset-resolver.js";
import type { BattleRunInput, BattleRunLauncher, BattleRunResult } from "../battle-run.js";

/**
 * Arquetipo de la partida de humo según el chasis del loadout (ARCHETYPES de E3).
 * Copia deliberada de `archetypeForChassis` (services/e6-bot-manager.ts) en vez
 * de importarla: ese módulo arrastra el pipeline completo de E6 (bot-manager/src/pipeline.js
 * → static-analysis → ast-analysis → `acorn`), que en este entorno no está instalado
 * (issue conocido, ajeno a B2) y rompería CUALQUIER test que importe este fichero,
 * aunque no toque builds en absoluto. Misma lógica, sin el arrastre.
 */
function archetypeForChassis(chassis: string): "scout" | "heavy" | "gunner" {
  const base = splitVersioned(chassis).base;
  if (base === "chassis.light") return "scout";
  if (base === "chassis.heavy") return "heavy";
  return "gunner";
}

export interface HttpBattleRunLauncherConfig {
  /** Base URL del servicio arena-engine, p. ej. http://arena-engine:8081 (red platform). */
  engineUrl: string;
  /** Secreto interno compartido con arena-engine (ARENA_ENGINE_INTERNAL_SECRET[_FILE] allí). */
  sharedSecret: string;
  /** BD para resolver el arquetipo real de cada bot (loadout → chassis → arquetipo, E3/E6). */
  db: Db;
  /** B9 · Override EXPLÍCITO del límite de ticks. Sin él (lo normal), los ticks
   *  salen de `timeLimitTicks` del ruleset REAL resuelto para la batalla, no de
   *  un número fijo del launcher. */
  ticks?: number;
  /**
   * B9 · Override ABSOLUTO del timeout de la llamada HTTP a arena-engine, ms.
   * SIN ÉL (camino de producción: `server.ts` no lo fija) el plazo se DERIVA de la
   * duración real de la batalla — ver `resolveRunTimeoutMs`. Un valor fijo aquí
   * que sea menor que esa duración condena la batalla a abortarse a medias: se
   * registra un aviso al resolverlo, pero se respeta (la palabra del operador
   * manda; los tests lo usan para provocar timeouts en milisegundos).
   */
  timeoutMs?: number;
  /**
   * B9 · Margen del cliente HTTP por encima del guard global del motor
   * (def. `RUN_HTTP_OVERHEAD_MS`, 30 s): arranque de contenedores, serialización
   * del replay y limpieza. Configurable sobre todo para poder probar el cálculo
   * del plazo en segundos en vez de en minutos.
   */
  runTimeoutOverheadMs?: number;
  /**
   * B6 · URL base del replay-service (p. ej. http://replay-service:8083). Si se
   * define, el replay REAL que devuelve arena-engine se verifica e ingesta ahí
   * (ver la nota de cabecera del fichero). Sin ella, ningún cambio de
   * comportamiento respecto a B2 (`ingested: false` siempre).
   */
  replayServiceUrl?: string;
  /**
   * B8 · Credencial interna con la que este launcher se autentica ante el
   * replay-service (cabecera `x-replay-ingest-auth`). Desde B8 la ingesta es
   * una ruta AUTENTICADA: sin esta credencial el replay-service responde 401 y
   * la ingesta se reporta honestamente como fallida (nunca `ingested: true`).
   * Nunca se registra en logs.
   */
  replayIngestSecret?: string;
  /** B6 · Si true, un replay que no verifica o una ingesta fallida hacen que el
   *  resultado operativo sea `status: "failed"` (modo estricto). Def. false
   *  (best-effort: la batalla no se pierde por un fallo de ingesta). */
  replayIngestRequired?: boolean;
  /** B6 · Timeout de la llamada HTTP al replay-service, ms (def. 10000). */
  replayIngestTimeoutMs?: number;
}

const DEFAULT_REPLAY_INGEST_TIMEOUT_MS = 10_000;
/** Runner declarado en `BattleRunResult.runner` para este launcher (visible en la respuesta). */
export const HTTP_LAUNCHER_RUNNER_ID = "arena-engine-http";

/**
 * B9 (bloqueante del supervisor) · Plazo de la llamada `POST /run`, DERIVADO de la
 * duración real de la batalla que se va a lanzar.
 *
 * El launcher abortaba a 30 s FIJOS. Mientras enviaba un `rulesetId` inválido eso
 * daba igual (la batalla moría antes de empezar), pero al resolver el ruleset de
 * verdad la batalla pasa a durar `ticks × 34 ms`: con los 9000 ticks de
 * `dm_practice@1` son ~306 s. Y una práctica de 2 bots en deathmatch SIEMPRE llega
 * al límite de tiempo (`scoreToWin: 5`, sin respawn: nadie hace 5 bajas), así que
 * el caso NORMAL habría sido abortar a los 30 s, dejar los contenedores corriendo
 * cuatro minutos más y tirar el replay. Cambiar un 502 por un timeout no es
 * arreglarlo.
 *
 * El plazo sale de `packages/game-rules/battle-timing.ts`, el mismo módulo que usa
 * el guard global del motor: la API SIEMPRE espera más que el motor, para que quien
 * se rinda primero sea quien puede limpiar los contenedores.
 */
export function resolveRunTimeoutMs(
  cfg: Pick<HttpBattleRunLauncherConfig, "timeoutMs" | "runTimeoutOverheadMs">,
  ticks: number,
): number {
  const derived = runHttpTimeoutMs(ticks, undefined, cfg.runTimeoutOverheadMs);
  if (cfg.timeoutMs === undefined) return derived;
  if (cfg.timeoutMs < theoreticalBattleMs(ticks)) {
    // Se respeta (la config explícita manda) pero NO en silencio: con este valor la
    // batalla se abortará a medias por definición.
    console.error(
      JSON.stringify({
        level: "warn",
        service: "api",
        msg: "timeout HTTP de arena-engine configurado por debajo de la duración teórica de la batalla: se abortará antes de que termine",
        configuredTimeoutMs: cfg.timeoutMs,
        theoreticalBattleMs: theoreticalBattleMs(ticks),
        derivedTimeoutMs: derived,
        ticks,
      }),
    );
  }
  return cfg.timeoutMs;
}

function resolveSharedSecretFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const file = env.ARENA_ENGINE_SHARED_SECRET_FILE;
  if (file) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      return raw || undefined;
    } catch {
      return undefined;
    }
  }
  const plain = env.ARENA_ENGINE_SHARED_SECRET;
  return plain && plain.length > 0 ? plain : undefined;
}

/**
 * Config del launcher HTTP resuelta del entorno. `null` si falta la URL del
 * motor o el secreto: el llamador (server.ts) entonces NO inyecta ningún
 * runner, así que `POST /battles/:id/run` sigue respondiendo 503
 * `runner_unavailable` aunque `S9_ENABLE_REAL_BATTLE_RUNS=1` (fail closed).
 */
export function httpBattleRunLauncherEnvConfig(
  env: NodeJS.ProcessEnv = process.env,
): { engineUrl: string; sharedSecret: string } | null {
  const engineUrl = env.ARENA_ENGINE_URL;
  const sharedSecret = resolveSharedSecretFromEnv(env);
  if (!engineUrl || !sharedSecret) return null;
  return { engineUrl, sharedSecret };
}

/**
 * B9 · Override ABSOLUTO del timeout de `POST /run` por entorno
 * (`ARENA_ENGINE_RUN_TIMEOUT_MS`). Sin la variable —lo normal— el plazo se DERIVA
 * de la duración de la batalla (`resolveRunTimeoutMs`). Un valor no numérico o < 1
 * se IGNORA (no se acepta a medias): mejor el plazo derivado, que siempre es
 * viable, que un valor mal escrito que aborte batallas buenas.
 */
export function runTimeoutEnvConfig(env: NodeJS.ProcessEnv = process.env): { timeoutMs?: number } {
  const raw = env.ARENA_ENGINE_RUN_TIMEOUT_MS;
  if (raw === undefined) return {};
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms < 1) {
    console.error(
      JSON.stringify({
        level: "error",
        service: "api",
        msg: "ARENA_ENGINE_RUN_TIMEOUT_MS no es un número de ms válido: se ignora y se usa el plazo derivado de la duración de la batalla",
      }),
    );
    return {};
  }
  return { timeoutMs: ms };
}

/**
 * B6 · Config de ingesta del replay resuelta del entorno. `replayServiceUrl`
 * ausente ⇒ ingesta desactivada (comportamiento B2 sin cambios). Mismos
 * nombres de variable que `scripts/e2e-real-battle-smoke.ts` a propósito
 * (mismo concepto, mismo operador que los configura).
 */
export function replayIngestEnvConfig(env: NodeJS.ProcessEnv = process.env): {
  replayServiceUrl?: string;
  replayIngestSecret?: string;
  replayIngestRequired: boolean;
  replayIngestTimeoutMs: number;
} {
  // B8 · misma convención que `ARENA_ENGINE_SHARED_SECRET[_FILE]`: fichero con
  // precedencia (Docker secrets), variable en claro como respaldo, y ausencia
  // ⇒ `undefined` (la ingesta fallará con 401 y se reportará, nunca se cuela).
  const replayIngestSecret = resolveIngestSecretFromEnv(env);
  return {
    ...(env.REPLAY_SERVICE_URL ? { replayServiceUrl: env.REPLAY_SERVICE_URL } : {}),
    ...(replayIngestSecret ? { replayIngestSecret } : {}),
    replayIngestRequired: env.REPLAY_INGEST_REQUIRED === "1",
    replayIngestTimeoutMs: Number(env.REPLAY_INGEST_TIMEOUT_MS ?? String(DEFAULT_REPLAY_INGEST_TIMEOUT_MS)),
  };
}

/** B6 · Resultado de intentar ingestar el replay en el replay-service. */
interface ReplayIngestOutcome {
  ingested: boolean;
  verifyMatches: boolean;
  /** Motivo del fallo (no verifica / HTTP / red), para el `error` del BattleRunResult en modo estricto. */
  reason?: string;
}

/**
 * B6 · Verifica el replay REAL devuelto por arena-engine y, solo si es DE ESTA
 * BATALLA y verifica, lo ingesta en el replay-service (POST /replays/:battleId,
 * mismo contrato que usa `scripts/e2e-real-battle-smoke.ts`). Dos guardas
 * independientes, ambas obligatorias, en este orden:
 *
 *   1. IDENTIDAD: `replay.header.battleId` debe ser EXACTAMENTE `battleId` (la
 *      batalla que se pidió lanzar). Sin esto, un replay real y verificable
 *      pero de OTRA batalla (caché de arena-engine, bug, o un arena-engine
 *      comprometido) se ingestaría igual bajo el id solicitado — mostraría la
 *      partida de un tercero como si fuera la tuya. Se comprueba ANTES de
 *      re-simular nada (más barato, y no hay nada que verificar si ni
 *      siquiera es la batalla correcta).
 *   2. INTEGRIDAD, EVENTOS INCLUIDOS: `verifyAndRecompute()` (no `verify()`
 *      solo) re-simula y devuelve `events`/`snapshots` RECOMPUTADOS. El JSONL
 *      que de verdad se ingesta se reconstruye con esos campos recomputados
 *      (nunca con `replay.events`/`replay.snapshots` tal como llegaron por la
 *      red): lo que el visor pinta queda cubierto por la misma garantía que
 *      el hash final, no solo la física. Ver la nota de cabecera del fichero.
 *
 * Un replay que falla cualquiera de las dos guardas JAMÁS se envía como si
 * fuera bueno.
 */
async function verifyAndIngestReplay(
  replayServiceUrl: string,
  battleId: string,
  replay: Replay,
  timeoutMs: number,
  /** B8 · credencial interna de ingesta. Ausente ⇒ ni se intenta (ver más abajo). */
  ingestSecret: string | undefined,
): Promise<ReplayIngestOutcome> {
  // B8 · Guarda 0 · sin credencial no se llega ni a re-simular. El replay-service
  // respondería 401 igualmente (fail-closed a los dos lados), pero re-simular una
  // batalla entera para que la respuesta sea siempre 401 es puro gasto, y el
  // motivo que se reporta así es el REAL ("falta credencial") en vez de un
  // "HTTP 401" que el operador tendría que ir a descifrar al log del otro servicio.
  if (!ingestSecret) {
    return {
      ingested: false,
      verifyMatches: false,
      reason:
        "ingesta del replay no configurada: falta la credencial interna del replay-service (REPLAY_INGEST_SECRET[_FILE])",
    };
  }
  // Guarda 1 · identidad — ANTES de re-simular: un replay de otra batalla no
  // es "casi correcto", es un replay de OTRA batalla, punto.
  if (replay.header?.battleId !== battleId) {
    return {
      ingested: false,
      verifyMatches: false,
      reason: `el replay recibido de arena-engine es de otra batalla (header.battleId=${JSON.stringify(replay.header?.battleId)}, se esperaba ${JSON.stringify(battleId)}): se rechaza, no se ingesta`,
    };
  }

  let outcome;
  try {
    outcome = await verifyAndRecompute(replay);
  } catch (err) {
    // El motor no pudo re-simular (cabecera incompleta, etc.): tratamos como "no
    // verifica" — nunca se ingesta algo que ni siquiera se pudo comprobar.
    return {
      ingested: false,
      verifyMatches: false,
      reason: `no se pudo verificar el replay: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const { verification, recomputed } = outcome;
  if (!verification.matches) {
    return {
      ingested: false,
      verifyMatches: false,
      reason: `el replay no verifica (verify_matches=false, divergedAtTick=${verification.divergedAtTick ?? "final"})`,
    };
  }

  // Guarda 2 (parte 2) · el JSONL que se ingesta usa SIEMPRE events/snapshots/
  // stateHashes/result RECOMPUTADOS, nunca los recibidos: header y commands sí
  // son los originales (son la "receta" que se acaba de comprobar que produce
  // exactamente estos hashes/eventos/snapshots — no hay nada más que sustituir).
  const verifiedReplay: Replay = {
    header: replay.header,
    commands: replay.commands,
    events: recomputed.events,
    snapshots: recomputed.snapshots,
    stateHashes: recomputed.stateHashes,
    result: recomputed.result,
  };

  const jsonl = toJsonl(verifiedReplay);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL(`/replays/${encodeURIComponent(battleId)}`, replayServiceUrl), {
      method: "POST",
      headers: {
        "content-type": "application/x-ndjson",
        // B8 · credencial interna de escritura. Va en cabecera (no en la URL ni
        // en el cuerpo) para que no acabe en el access log del gateway.
        [REPLAY_INGEST_AUTH_HEADER]: ingestSecret,
      },
      body: jsonl,
      signal: controller.signal,
    });
    if (res.status !== 201) {
      // El detalle de la respuesta del replay-service (podría llevar rutas
      // internas, versiones, etc.) se registra en el log del proceso, no se
      // devuelve al cliente de la API — este `reason` viaja hasta `error` del
      // BattleRunResult en modo estricto y ese sí puede ver el llamador.
      console.error(
        JSON.stringify({
          level: "error",
          service: "api",
          msg: "replay-service rechazó la ingesta del replay",
          battleId,
          status: res.status,
          body: (await res.text().catch(() => "")).slice(0, 500),
        }),
      );
      return {
        ingested: false,
        verifyMatches: true,
        reason: `la ingesta del replay fue rechazada por el servicio de replays (HTTP ${res.status})`,
      };
    }
    return { ingested: true, verifyMatches: true };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    // Igual criterio: el mensaje de red completo (puede llevar el host/puerto
    // interno del replay-service) se registra, no se expone al llamador.
    console.error(
      JSON.stringify({
        level: "error",
        service: "api",
        msg: "no se pudo ingestar el replay en el replay-service",
        battleId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return {
      ingested: false,
      verifyMatches: true,
      reason: timedOut ? "la ingesta del replay superó el timeout" : "el servicio de replays no está disponible",
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * B10 (issue #9) · Persiste la CPU REAL medida en los contenedores de los bots
 * (`ContainerBattleOutcome.cpuMsByBot`, cgroup de cada contenedor) en
 * `participants.cpu_ms`. De ahí la lee `runStatsJob` (replay-service) para
 * rellenar `battle_stats.stats.cpuMs`, que hasta B10 era `null` por diseño.
 *
 * Reglas, todas por el mismo motivo (una CPU inventada es peor que un hueco):
 *  - Se ITERA SOBRE LOS PARTICIPANTES QUE PIDIÓ LA API, no sobre las claves del
 *    objeto recibido por la red: arena-engine no puede escribir medidas de bots
 *    que no juegan esta batalla, ni colar claves como "__proto__". La lectura va
 *    por `safeLookup` (nada de `dict[botId]` a pelo).
 *  - Solo se escribe un número finito ≥ 0. Un `null`, un string o un NaN NO
 *    escriben nada: la columna se queda como estaba (no medida).
 *  - BEST-EFFORT: un fallo de BD se registra y NO tumba la batalla, que ya
 *    ocurrió y cuyo resultado es válido. Lo único que se pierde es la métrica.
 */
async function persistMeasuredCpuMs(
  db: Db,
  input: BattleRunInput,
  json: Record<string, unknown> | null,
): Promise<void> {
  const raw = json?.cpuMsByBot;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
  const measured = raw as Record<string, unknown>;
  for (const p of input.participants) {
    const value = safeLookup(measured, p.botId);
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    try {
      await db("participants").where({ battle_id: input.battleId, bot_id: p.botId }).update({ cpu_ms: value });
    } catch (err) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "api",
          msg: "no se pudo persistir la CPU medida del bot (la batalla no se ve afectada)",
          battleId: input.battleId,
          botId: p.botId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

/**
 * B9 · Comprueba que el mapa de la cabecera del replay devuelto por arena-engine es
 * EL MISMO que se pidió jugar, GEOMETRÍA INCLUIDA. Devuelve `null` si coincide (o
 * si la respuesta no trae cabecera de replay: ese caso ya lo trata el flujo de
 * ingesta, que nunca da por ingerido lo que no ha visto) y el motivo si no.
 *
 * REVISIÓN DEL SUPERVISOR (bloqueante, demostrado con una batalla real): la primera
 * versión comparaba `mapId@version#checksum`. Ese checksum NO se calcula sobre la
 * geometría del `ArenaMap`: `toEngineMap()` lo COPIA del documento origen, así que
 * quien fabrique la cabecera puede firmar cualquier geometría con la identidad de
 * otro mapa. El supervisor jugó `proc-test-7` firmado como `mvp-arena-01` y la
 * guarda lo aceptó e ingestó (`muros pedidos vs jugados: 3 vs 6`). Ahora se compara
 * el mapa ENTERO (`sameArenaMap`), que es barato (los mapas reales del catálogo
 * ocupan ~1,5 KB) y no da falsos positivos: el motor no muta `config.map`.
 */
function playedMapIdentityError(json: Record<string, unknown>, expected: ArenaMap): string | null {
  const replay = (json as { replay?: unknown }).replay;
  if (!replay || typeof replay !== "object") return null;
  const header = (replay as { header?: unknown }).header;
  if (!header || typeof header !== "object") return null;
  const played = (header as { map?: unknown }).map;
  if (!played || typeof played !== "object" || Array.isArray(played)) {
    return `la cabecera del replay no trae un mapa: no se puede comprobar que se jugara ${arenaMapLabel(expected)}`;
  }
  if (sameArenaMap(played, expected)) return null;

  const p = played as Partial<ArenaMap>;
  const playedLabel =
    typeof p.mapId === "string" && typeof p.version === "number" && typeof p.checksum === "string"
      ? arenaMapLabel(p as ArenaMap)
      : "un mapa sin identidad legible";
  const sameLabel = playedLabel === arenaMapLabel(expected);
  return (
    `la batalla NO se jugó en el mapa pedido (${arenaMapLabel(expected)}): la cabecera del replay trae ` +
    `${playedLabel}` +
    (sameLabel
      ? ` con la MISMA etiqueta pero geometría distinta (muros pedidos vs jugados: ` +
        `${expected.walls.length} vs ${Array.isArray(p.walls) ? p.walls.length : "?"})`
      : "") +
    `. Se rechaza y no se ingesta el replay.`
  );
}

interface ResolvedBot {
  botId: string;
  version: number;
  archetype: ReturnType<typeof archetypeForChassis>;
  imageDigest: string;
}

/** Arquetipo+imagen de un participante, resuelto desde su loadout REAL en BD
 *  (no un valor inventado): bot_versions.loadout_revision → bot_loadouts.chassis
 *  → archetypeForChassis (misma función que usa el pipeline E6). */
async function resolveBot(db: Db, p: BattleRunInput["participants"][number]): Promise<ResolvedBot> {
  const version = await db("bot_versions").where({ bot_id: p.botId, version: p.version }).first();
  const loadout = version
    ? await db("bot_loadouts").where({ bot_id: p.botId, revision: version.loadout_revision }).first()
    : undefined;
  if (!loadout) {
    throw new Error(`no se encontró el loadout del bot ${p.botId} v${p.version} (no debería ocurrir tras validar)`);
  }
  return {
    botId: p.botId,
    version: p.version,
    archetype: archetypeForChassis(loadout.chassis),
    imageDigest: p.artifactHash,
  };
}

/** Launcher real: API → arena-engine por HTTP. La API NUNCA llama a Docker. */
export function createHttpBattleRunLauncher(cfg: HttpBattleRunLauncherConfig): BattleRunLauncher {
  return {
    async launch(input: BattleRunInput): Promise<BattleRunResult> {
      // B9 · MAPA PRIMERO, sin resolver bots ni llamar a arena-engine: se resuelve
      // el mapId+mapVersion pedidos contra el CATÁLOGO REAL (map_versions) y se
      // obtiene la geometría concreta que jugará el motor. Si el mapa no existe, no
      // está publicado, su contenido no cuadra con la fila, su checksum canónico no
      // verifica, no pasa el validador de E4 o no es jugable, se RECHAZA con un
      // código distinguible — nunca se cae a un mapa por defecto (`resolveBattleMap`).
      const mapResolution = await resolveBattleMap(cfg.db, input.mapId, input.mapVersion);
      if (!mapResolution.ok) {
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          errorCode: mapResolution.code,
          error: `${mapResolution.code}: ${mapResolution.message}`,
        };
      }
      const arenaMap: ArenaMap = mapResolution.map;

      // B9 · RULESET/TICKS resueltos contra los catálogos reales (BD + motor) en vez
      // de enviar `input.mode` como rulesetId y un techo de ticks inventado. Un modo
      // sin ruleset equivalente, o un ruleset que juega OTRO modo, se rechaza.
      const rulesetResolution = await resolveBattleRuleset(cfg.db, input.mode, input.rulesetId ?? null);
      if (!rulesetResolution.ok) {
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          errorCode: rulesetResolution.code,
          error: `${rulesetResolution.code}: ${rulesetResolution.message}`,
        };
      }
      const ruleset = rulesetResolution.ruleset;

      // B9 (observación del supervisor) · COMPATIBILIDAD MAPA↔MODO, con el
      // comprobador REAL del motor (`modeMapIncompatibilities`, sim/modes.ts — el
      // mismo que usa `createMode`), no con una copia. Sin esto, una batalla
      // `zone_control` sobre un mapa sin zonas de captura (p. ej. mvp-arena-01, que
      // solo tiene zonas de daño) se acepta por la API, viaja a arena-engine y
      // revienta dentro del motor como 502 genérico. Los equipos son siempre
      // red/blue (container-battle.ts los asigna por índice par/impar).
      const teams = input.participants.length >= 2 ? ["red", "blue"] : ["red"];
      const incompat = modeMapIncompatibilities(ruleset, teams, arenaMap);
      if (incompat.length > 0) {
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          errorCode: "map_mode_incompatible",
          error:
            `map_mode_incompatible: el mapa ${arenaMapLabel(arenaMap)} no puede jugar el modo "${input.mode}": ` +
            `${incompat.join("; ")}. Se rechaza antes de lanzar nada.`,
        };
      }

      let bots: ResolvedBot[];
      try {
        bots = await Promise.all(input.participants.map((p) => resolveBot(cfg.db, p)));
      } catch (err) {
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          error: `no se pudo resolver el arquetipo de los bots: ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // `map` (geometría real), NUNCA `mapName` (mapa-fixture): son excluyentes en
      // el contrato de `/run`. `ticks` sale del ruleset resuelto salvo override
      // explícito del operador en la config del launcher.
      const body = {
        battleId: input.battleId,
        seed: input.seed ?? input.battleId,
        rulesetId: ruleset.rulesetId,
        ticks: cfg.ticks ?? ruleset.timeLimitTicks,
        map: arenaMap,
        bots,
      };

      // B9 · el plazo se resuelve POR BATALLA, con los ticks que se acaban de
      // fijar en el cuerpo: una batalla de 9000 ticks dura ~306 s y un timeout
      // fijo de 30 s la abortaría siempre a mitad (ver `resolveRunTimeoutMs`).
      const timeoutMs = resolveRunTimeoutMs(cfg, body.ticks);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(new URL("/run", cfg.engineUrl), {
          method: "POST",
          headers: { "content-type": "application/json", "x-arena-engine-auth": cfg.sharedSecret },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "AbortError";
        return {
          status: "failed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          error: timedOut
            ? `arena-engine no respondió en ${timeoutMs}ms`
            : `arena-engine inalcanzable: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (res.status === 200) {
        // arena-engine devuelve { result, replay, postures, cpuMsByBot } (Replay
        // real del motor). B10 (issue #9): la CPU medida en los contenedores se
        // persiste ANTES de cualquier retorno — es el único momento en que
        // existe, y sin persistirla `battle_stats.cpuMs` seguiría siendo null.
        await persistMeasuredCpuMs(cfg.db, input, json);
        if (!json) {
          return { status: "completed", runner: HTTP_LAUNCHER_RUNNER_ID, replay: null };
        }
        // B9 · GUARDA DE IDENTIDAD DEL MAPA (cierra el círculo del invariante). Hasta
        // aquí sabemos qué mapa PEDIMOS; la cabecera del replay dice qué mapa se
        // JUGÓ de verdad (replay.ts la graba desde `config.map` del motor y la
        // re-simulación parte de ella). Si no coinciden,
        // la batalla se jugó en otro mapa — da igual que el resto sea perfecto: se
        // marca `failed` y el replay NO se ingesta. Sin esta guarda, un arena-engine
        // con un bug de caché, una versión antigua desplegada o comprometido podría
        // devolver una partida jugada en otro mapa y la API la daría por buena.
        // Se compara el mapa ENTERO, geometría incluida (`sameArenaMap`), no solo
        // mapId+version+checksum: un checksum se puede reutilizar y la geometría
        // es justo lo que un motor comprometido cambiaría (GATE-FAIL de B9).
        const identityError = playedMapIdentityError(json, arenaMap);
        if (identityError) {
          return {
            status: "failed",
            runner: HTTP_LAUNCHER_RUNNER_ID,
            errorCode: "map_identity_mismatch",
            error: `map_identity_mismatch: ${identityError}`,
            replay: { ingested: false, battleId: input.battleId, verify_matches: false },
          };
        }
        // B6 · sin replayServiceUrl configurado, comportamiento IDÉNTICO a B2: no se
        // toca el replay-service, nunca se afirma "ingested: true" sin haberlo hecho.
        if (!cfg.replayServiceUrl) {
          return {
            status: "completed",
            runner: HTTP_LAUNCHER_RUNNER_ID,
            replay: { ingested: false, battleId: input.battleId },
          };
        }
        const replay = (json as { replay?: unknown }).replay as Replay | undefined;
        if (!replay || typeof replay !== "object" || !replay.header) {
          // arena-engine respondió 200 sin un replay utilizable: no hay nada que
          // verificar ni ingestar. Se refleja honestamente, no se inventa un éxito.
          return {
            status: "completed",
            runner: HTTP_LAUNCHER_RUNNER_ID,
            replay: { ingested: false, battleId: input.battleId, verify_matches: false },
          };
        }
        const outcome = await verifyAndIngestReplay(
          cfg.replayServiceUrl,
          input.battleId,
          replay,
          cfg.replayIngestTimeoutMs ?? DEFAULT_REPLAY_INGEST_TIMEOUT_MS,
          cfg.replayIngestSecret,
        );
        if (!outcome.ingested && cfg.replayIngestRequired) {
          return {
            status: "failed",
            runner: HTTP_LAUNCHER_RUNNER_ID,
            error: `REPLAY_INGEST_REQUIRED y la ingesta del replay falló: ${outcome.reason ?? "motivo desconocido"}`,
            replay: { ingested: false, battleId: input.battleId, verify_matches: outcome.verifyMatches },
          };
        }
        return {
          status: "completed",
          runner: HTTP_LAUNCHER_RUNNER_ID,
          replay: { ingested: outcome.ingested, battleId: input.battleId, verify_matches: outcome.verifyMatches },
        };
      }
      const message = typeof json?.message === "string" ? json.message : `arena-engine respondió ${res.status}`;
      return { status: "failed", runner: HTTP_LAUNCHER_RUNNER_ID, error: message };
    },
  };
}
