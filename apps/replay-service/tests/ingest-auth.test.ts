/**
 * B8 · DoD de la autenticación de ESCRITURA del replay-service.
 *
 * Tests de COMPORTAMIENTO, no de cadenas: cada caso levanta el servidor real
 * (supertest, sin abrir puerto), hace la petición HTTP de verdad y comprueba el
 * EFECTO OBSERVABLE — si el replay quedó o no en disco, si el visor lo ve, si el
 * barrido de retención borró algo. Un test que solo mirara el status o comparase
 * cabeceras aprobaría un sistema que responde 401 y aun así escribe el fichero.
 *
 * Las batallas son REALES (motor de E2), igual que en replay-service.test.ts:
 * el servicio existe para el formato real.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
import { REPLAY_INGEST_AUTH_HEADER, isValidInternalSecret, resolveIngestSecretFromEnv } from "../src/auth.js";

const SECRET = "s3cr3t-de-ingesta-de-pruebas";

beforeAll(async () => {
  await initPhysics();
});

async function recordBattle(seed: string, timeLimitTicks = 180): Promise<Replay> {
  return record(
    {
      battleId: `bat_${seed}`,
      seed,
      ruleset: loadRuleset("dm_practice@1", { timeLimitTicks }),
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

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "b8-ingest-auth-"));
}

describe("B8 · POST /replays/:battleId exige credencial interna", () => {
  it("SIN cabecera: 401 y el replay NO llega al disco ni al listado", async () => {
    const dir = tmp();
    const replay = await recordBattle("b8-sin-credencial");
    const id = replay.header.battleId;
    const app = createReplayServer({ dir, internalSecret: SECRET });

    const res = await request(app)
      .post(`/replays/${id}`)
      .set("content-type", "application/x-ndjson")
      .send(toJsonl(replay));

    expect(res.status).toBe(401);
    // Lo que importa: NO se escribió nada. (Un 401 que igualmente ingesta sería
    // exactamente el fallo que este bloque existe para impedir.)
    expect(existsSync(replayPath(dir, id))).toBe(false);
    expect(listReplays(dir, { limit: 100, order: "desc" })).toHaveLength(0);
    // Y el visor sigue sin ver la partida falsa.
    expect((await request(app).get("/replays")).body.items).toHaveLength(0);
    expect((await request(app).get(`/replays/${id}/index`)).status).toBe(404);
  });

  it("con credencial INCORRECTA (misma longitud y distinta longitud): 401 y nada en disco", async () => {
    const dir = tmp();
    const replay = await recordBattle("b8-credencial-mala");
    const id = replay.header.battleId;
    const app = createReplayServer({ dir, internalSecret: SECRET });

    // Misma longitud que el secreto real (descarta que la guarda sea un
    // simple `length !== length`) y longitudes distintas por arriba y por abajo
    // (descarta que `timingSafeEqual` lance y se cuele como 500 o como éxito).
    const wrongSameLength = "S3CR3T-DE-INGESTA-DE-PRUEBAX";
    expect(wrongSameLength.length).toBe(SECRET.length);
    // OJO (comprobado, no supuesto): NO se prueba `" " + SECRET`. Node normaliza
    // el OWS de las cabeceras HTTP, así que `req.header()` devuelve el valor ya
    // recortado y esa petición es, legítimamente, la credencial correcta. Probarlo
    // como "credencial mala" sería un test que exige un comportamiento falso.
    const candidates = [wrongSameLength, "corto", `${SECRET}-de-mas`, "", SECRET.replace("-", "_"), "__proto__"];

    for (const bad of candidates) {
      const res = await request(app)
        .post(`/replays/${id}`)
        .set("content-type", "application/x-ndjson")
        .set(REPLAY_INGEST_AUTH_HEADER, bad)
        .send(toJsonl(replay));
      expect(res.status, `credencial ${JSON.stringify(bad)}`).toBe(401);
    }
    expect(existsSync(replayPath(dir, id))).toBe(false);
    expect(listReplays(dir, { limit: 100, order: "desc" })).toHaveLength(0);
  });

  it("con la credencial CORRECTA: 201, el replay queda en disco y el visor lo ve", async () => {
    const dir = tmp();
    const replay = await recordBattle("b8-credencial-buena");
    const id = replay.header.battleId;
    const app = createReplayServer({ dir, internalSecret: SECRET });

    const res = await request(app)
      .post(`/replays/${id}`)
      .set("content-type", "application/x-ndjson")
      .set(REPLAY_INGEST_AUTH_HEADER, SECRET)
      .send(toJsonl(replay));

    expect(res.status).toBe(201);
    expect(res.body.battleId).toBe(id);
    expect(existsSync(replayPath(dir, id))).toBe(true);
    expect(listReplays(dir, { limit: 100, order: "desc" }).map((r) => r.battleId)).toContain(id);
  });

  it("FAIL-CLOSED: sin secreto configurado NINGUNA credencial sirve (no hay modo abierto)", async () => {
    const dir = tmp();
    const replay = await recordBattle("b8-fail-closed");
    const id = replay.header.battleId;
    // Servicio arrancado SIN internalSecret: es el escenario "el operador se
    // olvidó de configurarlo". La tentación de "si no hay secreto, deja pasar"
    // es justo lo que aquí NO puede ocurrir.
    const app = createReplayServer({ dir });

    for (const cred of [undefined, "", "lo-que-sea", SECRET]) {
      const req = request(app).post(`/replays/${id}`).set("content-type", "application/x-ndjson");
      if (cred !== undefined) req.set(REPLAY_INGEST_AUTH_HEADER, cred);
      const res = await req.send(toJsonl(replay));
      expect(res.status, `credencial ${JSON.stringify(cred)} sin secreto configurado`).toBe(401);
    }
    expect(existsSync(replayPath(dir, id))).toBe(false);
  });

  it("la respuesta 401 NUNCA devuelve el secreto configurado", async () => {
    const dir = tmp();
    const app = createReplayServer({ dir, internalSecret: SECRET });
    const res = await request(app).post("/replays/bat_x").send("");
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.text).not.toContain(SECRET);
  });

  it("la guarda va ANTES de parsear: un cuerpo basura sin credencial da 401, no 400", async () => {
    // Si la guarda estuviera después del parseo, un atacante sin credencial
    // podría distinguir "JSONL válido" de "JSONL roto" por el status.
    const dir = tmp();
    const app = createReplayServer({ dir, internalSecret: SECRET });
    const res = await request(app)
      .post("/replays/bat_x")
      .set("content-type", "application/x-ndjson")
      .send("esto no es un replay");
    expect(res.status).toBe(401);
  });
});

describe("B8 · POST /retention/sweep también exige credencial (borra replays)", () => {
  it("sin credencial: 401 y el replay almacenado SIGUE ahí", async () => {
    const dir = tmp();
    const replay = await recordBattle("b8-sweep");
    const id = replay.header.battleId;
    // Se ingesta por la vía interna (store), no por HTTP: aquí se prueba el barrido.
    ingestReplay(dir, replay, { official: true });
    expect(existsSync(replayPath(dir, id))).toBe(true);

    const app = createReplayServer({ dir, internalSecret: SECRET, now: () => Date.now() + 400 * 24 * 3600 * 1000 });
    const res = await request(app).post("/retention/sweep");
    expect(res.status).toBe(401);
    // El efecto observable: NO se barrió nada pese al reloj adelantado un año.
    expect(existsSync(replayPath(dir, id))).toBe(true);
  });

  it("con credencial: 200 y el barrido se ejecuta de verdad", async () => {
    const dir = tmp();
    const replay = await recordBattle("b8-sweep-ok");
    ingestReplay(dir, replay, { official: false });
    const app = createReplayServer({ dir, internalSecret: SECRET, now: () => Date.now() + 400 * 24 * 3600 * 1000 });
    const res = await request(app).post("/retention/sweep").set(REPLAY_INGEST_AUTH_HEADER, SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("deleted");
  });
});

describe("B8 · las rutas de LECTURA del visor siguen abiertas (no se rompe el visor)", () => {
  it("listado, fichero, índice y segmento responden SIN credencial", async () => {
    const dir = tmp();
    const replay = await recordBattle("b8-lectura");
    const stored = ingestReplay(dir, replay, { official: true });
    const id = replay.header.battleId;
    const app = createReplayServer({ dir, internalSecret: SECRET });

    const list = await request(app).get("/replays");
    expect(list.status).toBe(200);
    expect(list.body.items.map((r: { battleId: string }) => r.battleId)).toContain(id);

    const file = await request(app)
      .get(`/replays/${id}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    expect(file.status).toBe(200);
    expect((file.body as Buffer).length).toBe(stored.index.sizeBytes);

    const idx = await request(app).get(`/replays/${id}/index`);
    expect(idx.status).toBe(200);
    expect(idx.body.sha256).toBe(stored.index.sha256);

    const seg = await request(app).get(`/replays/${id}/segment?fromTick=0&toTick=60`);
    expect(seg.status).toBe(200);
    expect(seg.body.snapshots.length).toBeGreaterThan(0);

    // verify: POST pero de solo lectura (audita un replay ya publicado). Abierto
    // a propósito — ver la nota en server.ts.
    const ver = await request(app).post(`/replays/${id}/verify`);
    expect(ver.status).toBe(200);
    expect(ver.body.battleId).toBe(id);
  });

  it("las lecturas funcionan igual con el servicio SIN secreto (visor a salvo del despiste del operador)", async () => {
    const dir = tmp();
    const replay = await recordBattle("b8-lectura-sin-secreto");
    ingestReplay(dir, replay, { official: true });
    const app = createReplayServer({ dir });
    expect((await request(app).get("/replays")).status).toBe(200);
    expect((await request(app).get(`/replays/${replay.header.battleId}/index`)).status).toBe(200);
  });
});

describe("B8 · comparación en tiempo constante y resolución del secreto", () => {
  it("longitudes distintas devuelven false SIN lanzar (timingSafeEqual exige igual tamaño)", () => {
    expect(() => isValidInternalSecret("abcdef", "ab")).not.toThrow();
    expect(isValidInternalSecret("abcdef", "ab")).toBe(false);
    expect(isValidInternalSecret("ab", "abcdef")).toBe(false);
    // Multibyte: la comparación es sobre BYTES, no sobre code points.
    expect(isValidInternalSecret("ñ", "n")).toBe(false);
    expect(isValidInternalSecret("ñ", "ñ")).toBe(true);
  });

  it("fail-closed en los bordes: undefined/vacío nunca valida, ni contra sí mismo", () => {
    expect(isValidInternalSecret(undefined, undefined)).toBe(false);
    expect(isValidInternalSecret(undefined, "x")).toBe(false);
    expect(isValidInternalSecret("x", undefined)).toBe(false);
    expect(isValidInternalSecret("", "")).toBe(false);
  });

  it("un secreto correcto valida", () => {
    expect(isValidInternalSecret(SECRET, SECRET)).toBe(true);
  });

  it("el fichero tiene precedencia sobre la variable, y un fichero ilegible NO cae a la variable", () => {
    const dir = tmp();
    const file = join(dir, "secreto.txt");
    writeFileSync(file, `  ${SECRET}\n`, "utf8");
    expect(resolveIngestSecretFromEnv({ REPLAY_INGEST_SECRET_FILE: file } as NodeJS.ProcessEnv)).toBe(SECRET);
    // Fichero declarado + variable presente: manda el fichero.
    expect(
      resolveIngestSecretFromEnv({
        REPLAY_INGEST_SECRET_FILE: file,
        REPLAY_INGEST_SECRET: "otro",
      } as NodeJS.ProcessEnv),
    ).toBe(SECRET);
    // Fichero declarado pero inexistente: undefined (NO se cae a la variable en
    // claro, que sería degradar la seguridad justo cuando algo va mal).
    expect(
      resolveIngestSecretFromEnv({
        REPLAY_INGEST_SECRET_FILE: join(dir, "no-existe.txt"),
        REPLAY_INGEST_SECRET: "otro",
      } as NodeJS.ProcessEnv),
    ).toBeUndefined();
    expect(resolveIngestSecretFromEnv({ REPLAY_INGEST_SECRET: "otro" } as NodeJS.ProcessEnv)).toBe("otro");
    expect(resolveIngestSecretFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});
