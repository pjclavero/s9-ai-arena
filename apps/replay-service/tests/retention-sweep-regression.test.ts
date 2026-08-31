/**
 * REGRESIÓN DEL INCIDENTE DE PRODUCCIÓN (rollout 98f381ec → 4d469dc, VM108).
 *
 * Durante una sonda del despliegue, un `POST /retention/sweep` SIN NINGUNA
 * credencial devolvió HTTP 200 y BORRÓ los replays del volumen productivo
 * (se restauraron desde la copia Restic). La causa raíz no fue un defecto de
 * `main`: el contenedor corría una imagen de 98f381ec —anterior a la guarda de
 * escritura de B8— mal etiquetada como 4d469dc.
 *
 * Este fichero fija ese suceso como test de EFECTO, no de código de respuesta.
 * La diferencia importa: el fallo real de aquel día no fue "devolvió 200", fue
 * "los ficheros desaparecieron". Un test que solo mirase el status aprobaría un
 * servicio que responde 401 y aun así barre el disco. Aquí cada caso cuenta los
 * ficheros que quedan.
 *
 * El almacenamiento es SIEMPRE un directorio temporal recién creado
 * (`mkdtempSync`): este test jamás toca datos reales.
 *
 * Complementa a `ingest-auth.test.ts` (el DoD de B8) — no lo sustituye: allí se
 * prueba la guarda caso a caso, aquí se reproduce el escenario del incidente
 * completo (VARIOS replays ya almacenados y caducados, reloj adelantado, es
 * decir: todo listo para que el barrido borre) y se exige que sin credencial
 * válida NO desaparezca ninguno.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { loadRuleset } from "../../../packages/game-rules/index.js";
import { initPhysics } from "../../arena-engine/src/sim/physics.js";
import { record, toJsonl, type Replay } from "../../arena-engine/src/replay.js";
import { emptyArena, gunnerLoadout, scoutLoadout } from "../../arena-engine/src/fixtures.js";
import { HunterBot } from "../../arena-engine/src/stubs.js";
import { ingestReplay, listReplays, replayPath } from "../src/store.js";
import { createReplayServer } from "../src/server.js";
import { REPLAY_INGEST_AUTH_HEADER } from "../src/auth.js";

const SECRET = "secreto-de-ingesta-del-test-de-regresion";
/** Credenciales que un atacante (o una sonda despistada) probaría. */
const CREDENCIALES_INVALIDAS = [
  "",
  "otra-cosa",
  "secreto-de-ingesta-del-test-de-regresioN", // misma longitud, un byte distinto
  `${SECRET}x`, // más larga
  SECRET.slice(0, -1), // más corta
  "__proto__",
];
/** Un año por delante: cualquier replay no oficial del fixture está caducado. */
const RELOJ_ADELANTADO = () => Date.now() + 400 * 24 * 3600 * 1000;

beforeAll(async () => {
  await initPhysics();
});

async function grabarBatalla(seed: string): Promise<Replay> {
  return record(
    {
      battleId: `bat_${seed}`,
      seed,
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks: 120 }),
      map: emptyArena(),
      participants: [
        { id: "v_red", botId: "bot_red", team: "red", spec: gunnerLoadout() },
        { id: "v_blue", botId: "bot_blue", team: "blue", spec: scoutLoadout() },
      ],
    },
    (b) => {
      b.attachBot("v_red", new HunterBot("bot_red"));
      b.attachBot("v_blue", new HunterBot("bot_blue"));
    },
  );
}

/**
 * Fixture del incidente: DOS replays ya almacenados y caducables, en un
 * directorio temporal. Devuelve sus ids para poder afirmar sobre ficheros
 * concretos y no sobre un recuento agregado.
 */
async function fixtureDosReplays(): Promise<{ dir: string; ids: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), "regresion-sweep-"));
  const ids: string[] = [];
  for (const seed of ["incidente-a", "incidente-b"]) {
    const replay = await grabarBatalla(seed);
    // `official: false` ⇒ tiene fecha de caducidad ⇒ el barrido SÍ lo borraría.
    // Es deliberado: si el fixture fuese "oficial" (nunca caduca), el test
    // pasaría aunque la guarda no existiera, porque no habría nada que borrar.
    ingestReplay(dir, replay, { official: false });
    ids.push(replay.header.battleId);
  }
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(existsSync(replayPath(dir, id))).toBe(true);
  return { dir, ids };
}

function siguenLosDos(dir: string, ids: string[]): void {
  for (const id of ids) {
    expect(existsSync(replayPath(dir, id)), `el replay ${id} debería seguir en disco`).toBe(true);
  }
  expect(listReplays(dir, { limit: 100, order: "desc" })).toHaveLength(2);
}

describe("regresión · POST /retention/sweep no borra nada sin credencial válida", () => {
  it("SIN cabecera de auth: 401 y los DOS replays siguen en disco (el incidente)", async () => {
    const { dir, ids } = await fixtureDosReplays();
    const app = createReplayServer({ dir, internalSecret: SECRET, now: RELOJ_ADELANTADO });

    const res = await request(app).post("/retention/sweep");

    expect(res.status).toBe(401);
    // EL ASERTO QUE IMPORTA. En la imagen vieja esto era 200 y el directorio
    // quedaba vacío.
    siguenLosDos(dir, ids);
  });

  it("con credencial INVÁLIDA (varias formas): 401 y los DOS replays siguen en disco", async () => {
    const { dir, ids } = await fixtureDosReplays();
    const app = createReplayServer({ dir, internalSecret: SECRET, now: RELOJ_ADELANTADO });

    for (const mala of CREDENCIALES_INVALIDAS) {
      const res = await request(app).post("/retention/sweep").set(REPLAY_INGEST_AUTH_HEADER, mala);
      expect(res.status, `credencial ${JSON.stringify(mala)}`).toBe(401);
      // Se comprueba tras CADA intento: un borrado a la tercera petición sería
      // igual de grave y un aserto solo al final podría no verlo.
      siguenLosDos(dir, ids);
    }
  });

  it("FAIL-CLOSED: si el servicio arranca sin secreto, ni siquiera el secreto real barre", async () => {
    const { dir, ids } = await fixtureDosReplays();
    const app = createReplayServer({ dir, now: RELOJ_ADELANTADO }); // sin internalSecret

    for (const cred of [undefined, "", SECRET]) {
      const req = request(app).post("/retention/sweep");
      if (cred !== undefined) req.set(REPLAY_INGEST_AUTH_HEADER, cred);
      expect((await req).status, `credencial ${JSON.stringify(cred)}`).toBe(401);
    }
    siguenLosDos(dir, ids);
  });

  it("con credencial VÁLIDA: 200 y el barrido SÍ borra los dos caducados (comportamiento esperado)", async () => {
    // Documenta el otro lado del contrato: la guarda no rompe la retención.
    // Que este caso borre de verdad es también el CONTROL POSITIVO del fixture:
    // demuestra que en los casos anteriores había algo que borrar y que no
    // sobrevivían por casualidad.
    const { dir, ids } = await fixtureDosReplays();
    const app = createReplayServer({ dir, internalSecret: SECRET, now: RELOJ_ADELANTADO });

    const res = await request(app).post("/retention/sweep").set(REPLAY_INGEST_AUTH_HEADER, SECRET);

    expect(res.status).toBe(200);
    expect([...res.body.deleted].sort()).toEqual([...ids].sort());
    expect(res.body.kept).toEqual([]);
    for (const id of ids) expect(existsSync(replayPath(dir, id))).toBe(false);
  });

  it("la respuesta 401 no filtra el secreto ni la lista de replays existentes", async () => {
    const { dir } = await fixtureDosReplays();
    const app = createReplayServer({ dir, internalSecret: SECRET, now: RELOJ_ADELANTADO });
    const res = await request(app).post("/retention/sweep").set(REPLAY_INGEST_AUTH_HEADER, "mala");
    expect(res.status).toBe(401);
    expect(res.text).not.toContain(SECRET);
    expect(res.body).not.toHaveProperty("deleted");
    expect(res.body).not.toHaveProperty("kept");
  });
});

describe("regresión · POST /replays/:battleId no inyecta nada sin credencial válida", () => {
  it("sin auth y con auth inválida: 401, no aparece un tercer replay y los dos originales siguen", async () => {
    const { dir, ids } = await fixtureDosReplays();
    const intruso = await grabarBatalla("intruso");
    const idIntruso = intruso.header.battleId;
    const app = createReplayServer({ dir, internalSecret: SECRET });

    for (const cred of [undefined, ...CREDENCIALES_INVALIDAS]) {
      const req = request(app).post(`/replays/${idIntruso}`).set("content-type", "application/x-ndjson");
      if (cred !== undefined) req.set(REPLAY_INGEST_AUTH_HEADER, cred);
      const res = await req.send(toJsonl(intruso));
      expect(res.status, `credencial ${JSON.stringify(cred)}`).toBe(401);
      expect(existsSync(replayPath(dir, idIntruso))).toBe(false);
      siguenLosDos(dir, ids);
    }
  });

  it("body INVÁLIDO sin credencial: 401 (la guarda va antes de parsear; no se filtra si el JSONL cuela)", async () => {
    const { dir, ids } = await fixtureDosReplays();
    const app = createReplayServer({ dir, internalSecret: SECRET });

    const res = await request(app)
      .post("/replays/bat_lo_que_sea")
      .set("content-type", "application/x-ndjson")
      .send("{esto no es un replay}");

    expect(res.status).toBe(401);
    siguenLosDos(dir, ids);
  });

  it("body INVÁLIDO con credencial válida: 400 y sigue sin escribirse nada", async () => {
    const { dir, ids } = await fixtureDosReplays();
    const app = createReplayServer({ dir, internalSecret: SECRET });

    const res = await request(app)
      .post("/replays/bat_lo_que_sea")
      .set("content-type", "application/x-ndjson")
      .set(REPLAY_INGEST_AUTH_HEADER, SECRET)
      .send("{esto no es un replay}");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_replay");
    expect(existsSync(replayPath(dir, "bat_lo_que_sea"))).toBe(false);
    siguenLosDos(dir, ids);
  });

  it("battleId que no casa con el del cuerpo, con credencial válida: 400 y nada en disco", async () => {
    const { dir, ids } = await fixtureDosReplays();
    const intruso = await grabarBatalla("intruso-mismatch");
    const app = createReplayServer({ dir, internalSecret: SECRET });

    const res = await request(app)
      .post("/replays/bat_otro_distinto")
      .set("content-type", "application/x-ndjson")
      .set(REPLAY_INGEST_AUTH_HEADER, SECRET)
      .send(toJsonl(intruso));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("battle_id_mismatch");
    expect(existsSync(replayPath(dir, "bat_otro_distinto"))).toBe(false);
    expect(existsSync(replayPath(dir, intruso.header.battleId))).toBe(false);
    siguenLosDos(dir, ids);
  });
});
