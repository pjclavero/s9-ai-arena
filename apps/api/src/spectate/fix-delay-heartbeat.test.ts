/**
 * FIX-DELAY · Latidos de control del canal de espectador con retardo anti-coaching.
 *
 * Defecto demostrado en producción (2026-11-15, torneo con delaySeconds=30): el
 * gateway difería TODOS los mensajes `delayMs`; tras el init el canal quedaba mudo
 * 30 s y el watchdog del visor (10 s) lo cerraba en bucle: emisión congelada en el
 * tick 0.
 *
 * Contrato que fija este test (gateway REAL en un puerto efímero, ws real):
 *  - con retardo, los latidos llegan SIN retardo (≥ 1 Hz) y los snapshots CON él;
 *  - un latido no contiene estado de la batalla ni marcas de tiempo: tipo fijo y
 *    `delayMs` constante, cadencia fija;
 *  - el init anuncia el retardo efectivo en ms;
 *  - reconectar NO reinicia el retardo: la conexión nueva sigue del buffer del feed;
 *  - sin retardo, ni un latido: todo como siempre;
 *  - canales laterales (P2-1 de la revisión): el `id` de cada latido es un UUID v4
 *    distinto cada vez (no un contador ni nada derivado de lo retenido), y la
 *    cadencia, la presencia y el cuerpo del latido son los mismos con la batalla
 *    ociosa, con mensajes retenidos y tras el fin real de la batalla mientras el
 *    socket siga abierto;
 *  - cadencia (P2-3/P3-3 de REVIEW-282-DELTA2): TODO hueco entre latidos
 *    consecutivos de la vida del socket cae en `HB_MS ± BAND_MS`, incluido el
 *    tramo «fin real no entregado» (la batalla ya terminó y el resultado sigue
 *    retenido), que es justo el que oculta el retardo;
 *  - estructura del `id` (P3-4): el latido sale por el sobre común con
 *    `id: randomUUID()` sin transformar y `heartbeatMessage` sólo recibe
 *    `conn.delayMs` (AST de gateway.ts, no texto).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import { WebSocket } from "ws";
import { SpectateGateway, heartbeatMessage, spectateProtocols, type SpectatableBattle } from "./gateway.js";
import { signSpectateTicket } from "../auth/tokens.js";

beforeAll(() => {
  process.env.ARENA_DEV_INSECURE_SECRETS ??= "1";
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const PRODUCE_EVERY_MS = 40;
const SLACK_MS = 80;
const HB_MS = 100;
/**
 * Banda de cadencia: todo hueco entre latidos consecutivos en `HB_MS ± BAND_MS`.
 * Medido en VM111 (4 vCPU) sobre la línea base: ver FIX-DELAY-P2c. Un latido
 * omitido da ≈ 2·HB, uno extra ≈ 0, una cadencia doble ≈ HB/2 y un desfase de
 * fase de 30 ms deja un hueco de ≈ HB ± 30 en la transición: todos fuera.
 */
const BAND_MS = 20;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** UUID v4 canónico (minúsculas, como `crypto.randomUUID()`). */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * El `id` de cada latido: UUID v4 y distinto en cada uno (ni contador ni derivado).
 * Forma y unicidad no bastan (P3-1 de REVIEW-282-DELTA): un UUID v4 válido y único
 * puede llevar un contador o lo retenido en parte de sus bits. Por eso tampoco se
 * puede repetir ni el primer grupo (32 bits) ni el último (48 bits): con ~40 latidos
 * aleatorios la probabilidad de colisión es < 1e-6 (32 bits) y < 1e-11 (48 bits).
 */
function expectRandomIds(beats: { msg: any }[]): void {
  for (const b of beats) {
    expect(typeof b.msg.id, `id no textual: ${JSON.stringify(b.msg.id)}`).toBe("string");
    expect(b.msg.id, `id de latido no es UUID v4: ${JSON.stringify(b.msg.id)}`).toMatch(UUID_V4);
  }
  const ids: string[] = beats.map((b) => b.msg.id);
  expect(new Set(ids).size, "ids de latido repetidos").toBe(ids.length);
  const first = ids.map((id) => id.slice(0, 8));
  expect(new Set(first).size, `primer grupo (32 bits) repetido entre latidos: ${first.join(",")}`).toBe(ids.length);
  const last = ids.map((id) => id.slice(-12));
  expect(new Set(last).size, `último grupo (48 bits) repetido entre latidos: ${last.join(",")}`).toBe(ids.length);
}

/** AST (ESTree, acorn) de gateway.ts sin tipos; ver HEARTBEAT_ID_STRUCTURE. */
function parseGateway(): any {
  const src = readFileSync(fileURLToPath(new URL("./gateway.ts", import.meta.url)), "utf8");
  return acorn.parse(stripTypeScriptTypes(src, { mode: "strip" }), { ecmaVersion: "latest", sourceType: "module" });
}

/** Todos los nodos ESTree bajo `root` (recorrido en profundidad, sin repetir). */
function nodes(root: any): any[] {
  const out: any[] = [];
  const walk = (n: any) => {
    if (!n || typeof n.type !== "string") return;
    out.push(n);
    for (const [k, v] of Object.entries(n)) {
      if (k === "loc" || k === "range") continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(root);
  return out;
}

/**
 * Batalla gobernada por el test: ociosa (sin producir nada) hasta `start()`, produce
 * snapshots y eventos hasta `finish()`, y después queda terminada con resultado.
 */
function controlledBattle() {
  let done = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const battle: SpectatableBattle = {
    snapshots: [],
    publicEvents: [],
    isFinished: () => done,
    getResult: () => (done ? { winner: "red" } : null),
  };
  let tick = 0;
  const start = () => {
    timer = setInterval(() => {
      tick++;
      battle.snapshots.push({
        tick,
        vehicles: [{ id: "v_red", team: "red", position: { x: 1000 + tick, y: 2000 + tick }, hp: 777 - tick }],
      });
      if (tick % 5 === 0) battle.publicEvents.push({ type: "vehicle_destroyed", tick, vehicleId: "v_blue" });
    }, PRODUCE_EVERY_MS);
  };
  const finish = () => {
    if (timer) clearInterval(timer);
    timer = null;
    done = true;
  };
  cleanups.push(() => {
    if (timer) clearInterval(timer);
  });
  return { battle, start, finish };
}

/** Batalla con vehículos (posición + hp) y eventos: lo que un latido NO debe llevar. */
function liveBattle() {
  const producedAt = new Map<number, number>();
  const battle: SpectatableBattle = { snapshots: [], publicEvents: [], isFinished: () => false, getResult: () => null };
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    producedAt.set(tick, Date.now());
    battle.snapshots.push({
      tick,
      vehicles: [{ id: "v_red", team: "red", position: { x: 1000 + tick, y: 2000 + tick }, hp: 777 - tick }],
    });
    if (tick % 5 === 0) battle.publicEvents.push({ type: "vehicle_destroyed", tick, vehicleId: "v_blue" });
  }, PRODUCE_EVERY_MS);
  cleanups.push(() => clearInterval(timer));
  return { battle, producedAt };
}

type Received = { msg: any; raw: string; at: number };
function connect(
  gw: SpectateGateway,
  battleId: string,
): Promise<{ ws: WebSocket; got: Received[]; connectedAt: number }> {
  const ticket = signSpectateTicket({ battleId, jti: randomUUID(), anon: true } as any, 60);
  const ws = new WebSocket(`ws://127.0.0.1:${gw.port}/spectate/${battleId}`, spectateProtocols(ticket));
  cleanups.push(() => ws.terminate());
  const got: Received[] = [];
  ws.on("message", (d) => got.push({ msg: JSON.parse(String(d)), raw: String(d), at: Date.now() }));
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve({ ws, got, connectedAt: Date.now() }));
    ws.once("error", reject);
  });
}

function gateway(): SpectateGateway {
  const gw = new SpectateGateway({ publicSpectateEnabled: true, heartbeatIntervalMs: HB_MS });
  cleanups.push(() => gw.close());
  return gw;
}

describe("FIX-DELAY · latidos sin retardo, snapshots con retardo", () => {
  it("SPECTATOR_DELAY_HEARTBEAT · ANTI_COACHING_NOT_BYPASSED · con retardo: latidos inmediatos y ≥ 1 Hz durante la espera; snapshots y eventos sólo tras el retardo", async () => {
    const DELAY_MS = 1500;
    const gw = gateway();
    const { battle, producedAt } = liveBattle();
    gw.attachBattle("b-hb", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });
    const { got, connectedAt } = await connect(gw, "b-hb");
    await sleep(DELAY_MS + 700);

    expect(got[0].msg.type).toBe("init");
    // El init anuncia el retardo efectivo (ms) y el periodo de latidos.
    expect(got[0].msg.spectator.delayMs).toBe(DELAY_MS);
    expect(got[0].msg.spectator.heartbeatIntervalMs).toBe(HB_MS);

    const beats = got.filter((g) => g.msg.type === "heartbeat");
    const firstSnap = got.find((g) => g.msg.type === "snapshot");
    expect(firstSnap, "no llegó ningún snapshot tras el retardo").toBeDefined();
    // Latidos SIN retardo: el primero casi al conectar, y varios ANTES del primer snapshot.
    expect(beats.length).toBeGreaterThan(5);
    expect(beats[0].at - connectedAt, "el primer latido llegó diferido").toBeLessThan(300);
    const beforeFirstSnap = beats.filter((b) => b.at < firstSnap!.at);
    expect(beforeFirstSnap.length).toBeGreaterThanOrEqual(Math.floor((DELAY_MS - 300) / HB_MS));
    // Ningún hueco entre latidos supera 1 s (≥ 1 Hz) mientras se espera.
    for (let i = 1; i < beforeFirstSnap.length; i++) {
      expect(beforeFirstSnap[i].at - beforeFirstSnap[i - 1].at).toBeLessThan(1000);
    }
    for (const b of beats) expect(b.msg.delayMs).toBe(DELAY_MS);

    // Snapshots y eventos CON retardo: ninguno antes de su producción + retardo.
    const snaps = got.filter((g) => g.msg.type === "snapshot");
    expect(snaps.length).toBeGreaterThan(3);
    for (const s of snaps) {
      const lag = s.at - producedAt.get(s.msg.snapshot.tick)!;
      expect(lag, `tick ${s.msg.snapshot.tick} llegó con ${lag} ms`).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
    }
    const events = got.filter((g) => g.msg.type === "event");
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.at - producedAt.get(e.msg.event.tick)!).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
    }
  }, 15_000);

  it("NO_STATE_LEAK_IN_HEARTBEAT · un latido NO contiene estado de la batalla ni marcas de tiempo: tipo fijo y retardo constante", async () => {
    const gw = gateway();
    const { battle } = liveBattle();
    await sleep(400); // la batalla ya tiene snapshots y eventos con valores reconocibles
    gw.attachBattle("b-leak", battle, { spectator: { delaySeconds: 1 }, pollIntervalMs: 10 });
    const { got } = await connect(gw, "b-leak");
    await sleep(1600);
    const beats = got.filter((g) => g.msg.type === "heartbeat");
    expect(beats.length).toBeGreaterThan(5);
    for (const b of beats) {
      // Whitelist ESTRUCTURAL exacta: tipo fijo + retardo constante (+ el sobre
      // común v/id). Ni estado de batalla ni marcas de tiempo ni nada que dependa
      // de lo retenido (sería un canal lateral): cualquier campo nuevo rompe aquí.
      expect(Object.keys(b.msg).sort()).toEqual(["delayMs", "id", "type", "v"]);
      expect(b.msg.type).toBe("heartbeat");
      expect(b.msg.v).toBe(1);
      expect(b.msg.delayMs).toBe(1000);
    }
    // El id NO es un canal lateral: UUID v4 aleatorio, distinto en cada latido.
    expectRandomIds(beats);
    // Todos los latidos son IDÉNTICOS salvo el id aleatorio: nada varía con la batalla.
    const bodies = new Set(beats.map(({ msg: { id: _id, ...rest } }) => JSON.stringify(rest)));
    expect([...bodies]).toEqual([JSON.stringify({ v: 1, type: "heartbeat", delayMs: 1000 })]);
    // Cadencia FIJA: el intervalo entre latidos no depende de la actividad de la batalla.
    const gaps = beats.slice(1).map((b, i) => b.at - beats[i].at);
    for (const g of gaps) expect(g).toBeLessThan(HB_MS * 3);
    // La fábrica pura tampoco: sólo relojes.
    expect(heartbeatMessage(30_000)).toEqual({ type: "heartbeat", delayMs: 30_000 });
  }, 10_000);

  it("HEARTBEAT_ID_STRUCTURE · el latido sale por el sobre común con id = randomUUID() sin transformar y heartbeatMessage sólo recibe conn.delayMs (AST de gateway.ts)", () => {
    // P3-4 de REVIEW-282-DELTA2: un test de forma o de unicidad no excluye que el id
    // lleve bits de estado en los grupos intermedios o en la variante. La defensa
    // general es estructural y se comprueba sobre el AST (no con texto): TS 7 no
    // expone API de compilador en JS, así que se quitan los tipos con
    // `stripTypeScriptTypes` de Node (sustituye por espacios, conserva posiciones)
    // y se parsea con acorn.
    const ast = parseGateway();
    const all = nodes(ast);
    const isId = (n: any, name: string) => n?.type === "Identifier" && n.name === name;
    const isMember = (n: any, obj: string, prop: string) =>
      n?.type === "MemberExpression" && !n.computed && isId(n.object, obj) && isId(n.property, prop);
    const isThisMember = (n: any, prop: string) =>
      n?.type === "MemberExpression" && !n.computed && n.object.type === "ThisExpression" && isId(n.property, prop);

    // 1. `randomUUID` es el de node:crypto y no hay otra declaración que lo sombree.
    const imp = ast.body.filter(
      (n: any) =>
        n.type === "ImportDeclaration" &&
        n.source.value === "node:crypto" &&
        n.specifiers.some(
          (sp: any) => sp.type === "ImportSpecifier" && isId(sp.imported, "randomUUID") && isId(sp.local, "randomUUID"),
        ),
    );
    expect(imp.length, "randomUUID no se importa de node:crypto").toBe(1);
    const shadows = all.filter(
      (n: any) =>
        (n.type === "VariableDeclarator" && isId(n.id, "randomUUID")) ||
        ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression") &&
          (isId(n.id, "randomUUID") || n.params.some((q: any) => isId(q, "randomUUID")))) ||
        (n.type === "ArrowFunctionExpression" && n.params.some((q: any) => isId(q, "randomUUID"))),
    );
    expect(shadows.length, "otra declaración sombrea randomUUID").toBe(0);

    // 2. Hay UNA sola llamada a randomUUID en el gateway: el `id` del sobre de sendTo,
    //    sin argumentos y sin transformar (ni slice, ni concatenación, ni plantilla).
    const uuidCalls = all.filter((n: any) => n.type === "CallExpression" && isId(n.callee, "randomUUID"));
    expect(uuidCalls.length, "randomUUID se llama en más de un sitio").toBe(1);
    const sendTo = all.find((n: any) => n.type === "MethodDefinition" && isId(n.key, "sendTo"));
    expect(sendTo, "no hay método sendTo").toBeDefined();
    const inSendTo = nodes(sendTo);
    const payloadDecl = inSendTo.filter((n: any) => n.type === "VariableDeclarator" && isId(n.id, "payload"));
    expect(payloadDecl.length, "sendTo: una sola declaración de payload").toBe(1);
    const init = payloadDecl[0].init;
    expect(
      init?.type === "CallExpression" && isMember(init.callee, "JSON", "stringify") && init.arguments.length === 1,
      "sendTo: payload = JSON.stringify(sobre)",
    ).toBe(true);
    const env = init.arguments[0];
    expect(env.type, "sendTo: el sobre es un objeto literal").toBe("ObjectExpression");
    const shape = env.properties.map((q: any) =>
      q.type === "SpreadElement" ? `...${q.argument.name}` : `${q.key.name}:${q.value.type}`,
    );
    expect(shape, "sendTo: sobre {v: 1, id: randomUUID(), ...msg}").toEqual([
      "v:Literal",
      "id:CallExpression",
      "...msg",
    ]);
    expect(env.properties[0].value.value).toBe(1);
    const idVal = env.properties[1].value;
    expect(idVal, "sendTo: el id del sobre no es la llamada directa a randomUUID()").toBe(uuidCalls[0]);
    expect(idVal.arguments.length, "randomUUID() con argumentos").toBe(0);
    // …y el payload sale tal cual: cada envío del socket manda `payload` sin tocar.
    const sends = inSendTo.filter(
      (n: any) =>
        n.type === "CallExpression" && n.callee.type === "MemberExpression" && isId(n.callee.property, "send"),
    );
    expect(sends.length, "sendTo: un solo ws.send").toBe(1);
    expect(sends[0].arguments.map((a: any) => a.type + ":" + a.name)).toEqual(["Identifier:payload"]);
    const payloadRefs = inSendTo.filter((n: any) => isId(n, "payload"));
    expect(payloadRefs.length, "sendTo: payload sólo se declara y se envía").toBe(2);

    // 3. El latido: UNA llamada a heartbeatMessage, con `conn.delayMs` como único
    //    argumento (nada derivado del estado), pasada TAL CUAL como mensaje a sendTo
    //    (sin envolver en un objeto que pise el id del sobre con su `...msg`).
    const hbCalls = all.filter((n: any) => n.type === "CallExpression" && isId(n.callee, "heartbeatMessage"));
    expect(hbCalls.length, "heartbeatMessage se llama en más de un sitio").toBe(1);
    const hb = hbCalls[0];
    expect(hb.arguments.length, "heartbeatMessage: un solo argumento").toBe(1);
    expect(isMember(hb.arguments[0], "conn", "delayMs"), "heartbeatMessage recibe algo distinto de conn.delayMs").toBe(
      true,
    );
    const carriers = all.filter(
      (n: any) => n.type === "CallExpression" && isThisMember(n.callee, "sendTo") && n.arguments.includes(hb),
    );
    expect(carriers.length, "el latido no se pasa directamente a this.sendTo").toBe(1);
    const args = carriers[0].arguments;
    expect(args.length, "sendTo del latido: (conn, heartbeatMessage(conn.delayMs), true)").toBe(3);
    expect(isId(args[0], "conn")).toBe(true);
    expect(args[1], "el mensaje del latido no es heartbeatMessage(...) tal cual").toBe(hb);
    expect(args[2].type === "Literal" && args[2].value === true, "el latido no va inmediato").toBe(true);

    // 4. La fábrica: un solo parámetro y devuelve exactamente {type: "heartbeat", delayMs}
    //    (sin `id` propio que pisaría el del sobre).
    const fns = all.filter((n: any) => n.type === "FunctionDeclaration" && isId(n.id, "heartbeatMessage"));
    expect(fns.length).toBe(1);
    const fn = fns[0];
    expect(fn.params.map((q: any) => q.name)).toEqual(["delayMs"]);
    expect(fn.body.body.length, "heartbeatMessage: un solo return").toBe(1);
    const ret = fn.body.body[0];
    expect(ret.type).toBe("ReturnStatement");
    expect(ret.argument.type).toBe("ObjectExpression");
    const retShape = ret.argument.properties.map((q: any) =>
      q.type === "Property" && !q.computed && q.value.type === "Literal"
        ? `${q.key.name}=${JSON.stringify(q.value.value)}`
        : q.type === "Property" && !q.computed && q.value.type === "Identifier"
          ? `${q.key.name}=@${q.value.name}`
          : q.type,
    );
    expect(retShape).toEqual(['type="heartbeat"', "delayMs=@delayMs"]);
  });

  it("HEARTBEAT_SIDE_CHANNELS · cadencia, presencia y cuerpo del latido idénticos con batalla ociosa, con mensajes retenidos y tras el fin real (socket abierto)", async () => {
    const DELAY_MS = 1000;
    const WINDOW_MS = 900;
    const gw = gateway();
    const { battle, start, finish } = controlledBattle();
    gw.attachBattle("b-side", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });
    const { ws, got } = await connect(gw, "b-side");
    const feed = (gw as any).feeds.get("b-side");
    const [conn] = [...feed.clients];

    // Fase A · OCIOSA: la batalla no ha producido nada ⇒ nada retenido.
    const aFrom = Date.now();
    await sleep(WINDOW_MS);
    const aTo = Date.now();
    expect(battle.snapshots.length, "la fase ociosa produjo snapshots").toBe(0);
    expect(conn.timers.size, "en la fase ociosa no debe haber nada retenido").toBe(0);

    // Fase B · RETENIDOS: la batalla produce y el retardo retiene mensajes.
    start();
    await sleep(150);
    const bFrom = Date.now();
    await sleep(WINDOW_MS / 2);
    expect(conn.timers.size, "en la fase B debe haber mensajes retenidos").toBeGreaterThan(0);
    await sleep(WINDOW_MS / 2);
    const bTo = Date.now();
    expect(conn.timers.size, "en la fase B debe haber mensajes retenidos").toBeGreaterThan(0);

    // Fase «FIN REAL NO ENTREGADO» (P2-3): la batalla ya terminó (feed.finished)
    // pero el resultado y la cola de snapshots siguen retenidos. Es el tramo que
    // oculta el retardo: si el latido cambiara aquí, revelaría el fin antes de
    // tiempo. Se comprueba que el tramo EXISTE de verdad y que tiene latidos.
    finish();
    const deadline = Date.now() + 2000;
    while (!feed.finished && Date.now() < deadline) await sleep(2);
    const realFinAt = Date.now();
    expect(feed.finished, "el gateway no vio el fin de la batalla").toBe(true);
    expect(conn.timers.size, "fin real: debe quedar algo retenido sin entregar").toBeGreaterThan(0);
    expect(
      got.some((g) => g.msg.type === "result"),
      "fin real: el resultado no debe haber llegado aún",
    ).toBe(false);
    await sleep(DELAY_MS + 300);
    // Fase C · TERMINADA: retenidos ya entregados (resultado incluido) y el
    // socket SIGUE abierto.
    expect(conn.timers.size, "tras el fin y el retardo no debe quedar nada retenido").toBe(0);
    const result = got.find((g) => g.msg.type === "result");
    expect(result, "el resultado retrasado no llegó").toBeDefined();
    const resultAt = result!.at;
    const cFrom = Date.now();
    await sleep(WINDOW_MS);
    const cTo = Date.now();
    expect(ws.readyState, "el socket debía seguir abierto").toBe(WebSocket.OPEN);

    const beats = got.filter((g) => g.msg.type === "heartbeat");
    const inWin = (from: number, to: number) => beats.filter((b) => b.at >= from && b.at < to);
    const phases = { ociosa: inWin(aFrom, aTo), retenidos: inWin(bFrom, bTo), terminada: inWin(cFrom, cTo) };
    // Presencia y cadencia iguales en las tres fases (la cadencia es fija: HB_MS).
    const expected = Math.floor(WINDOW_MS / HB_MS);
    const counts = Object.values(phases).map((p) => p.length);
    for (const [name, p] of Object.entries(phases)) {
      const why = `fase ${name}: ${p.length} latidos (esperados ≈ ${expected})`;
      expect(p.length, why).toBeGreaterThanOrEqual(expected - 3);
      expect(p.length, why).toBeLessThanOrEqual(expected + 3);
    }
    expect(Math.max(...counts) - Math.min(...counts), `latidos por fase ${counts.join("/")}`).toBeLessThanOrEqual(2);

    // El tramo «fin real no entregado» existe, dura ≈ el retardo y tiene latidos.
    const finReal = inWin(realFinAt, resultAt);
    expect(resultAt - realFinAt, "tramo fin real → resultado demasiado corto").toBeGreaterThanOrEqual(DELAY_MS - 200);
    expect(finReal.length, `tramo fin real no entregado: ${finReal.length} latidos`).toBeGreaterThanOrEqual(7);

    // Cadencia (P2-3/P3-3): TODO hueco entre latidos consecutivos de la vida del
    // socket en HB_MS ± BAND_MS, transiciones de fase incluidas; no sólo dentro de
    // ventanas. Así no hay tramo sin observar ni escalón de fase que se escape.
    const phaseOf = (at: number) =>
      at < aTo
        ? "ociosa"
        : at < bTo
          ? "retenidos"
          : at < realFinAt
            ? "fin-pedido"
            : at < resultAt
              ? "fin-real-no-entregado"
              : "terminada";
    const bandCheck = (p: Received[], label: string) => {
      for (let i = 1; i < p.length; i++) {
        const gap = p[i].at - p[i - 1].at;
        const where = `${label}: hueco ${i - 1}→${i} de ${gap} ms en fase ${phaseOf(p[i].at)} (periodo ${HB_MS} ± ${BAND_MS} ms)`;
        expect(Math.abs(gap - HB_MS), where).toBeLessThanOrEqual(BAND_MS);
      }
    };
    bandCheck(finReal, "fin real no entregado");
    bandCheck(beats, "vida del socket");
    expect(cTo - beats[beats.length - 1].at, "el latido se apagó antes de cerrar el socket").toBeLessThan(
      HB_MS + BAND_MS,
    );
    // Cuerpo IDÉNTICO en todas las fases salvo el id; el id, UUID v4 distinto.
    const bodies = new Set(beats.map(({ msg: { id: _id, ...rest } }) => JSON.stringify(rest)));
    expect([...bodies]).toEqual([JSON.stringify({ v: 1, type: "heartbeat", delayMs: DELAY_MS })]);
    expectRandomIds(beats);
  }, 15_000);

  it("reconectar NO reinicia el retardo: la conexión nueva sigue del buffer del feed", async () => {
    const DELAY_MS = 1500;
    const gw = gateway();
    const { battle, producedAt } = liveBattle();
    const attachedAt = Date.now();
    gw.attachBattle("b-resume", battle, { spectator: { delaySeconds: DELAY_MS / 1000 }, pollIntervalMs: 10 });
    const first = await connect(gw, "b-resume");
    await sleep(1000);
    first.ws.close(); // corte a mitad de la espera
    await sleep(100);
    const second = await connect(gw, "b-resume");
    await sleep(DELAY_MS);
    const snaps = second.got.filter((g) => g.msg.type === "snapshot");
    expect(snaps.length, "la reconexión no recibió nada").toBeGreaterThan(3);
    const firstAt = snaps[0].at;
    // Si el retardo se reiniciara, el primer snapshot llegaría en connectedAt + retardo.
    expect(firstAt - second.connectedAt, "el retardo se reinició con la reconexión").toBeLessThan(DELAY_MS - 500);
    expect(firstAt - attachedAt).toBeLessThan(DELAY_MS + 400);
    // …y sin adelantar nada: cada snapshot, tras su producción + retardo.
    for (const s of snaps) {
      expect(s.at - producedAt.get(s.msg.snapshot.tick)!).toBeGreaterThanOrEqual(DELAY_MS - SLACK_MS);
    }
  }, 15_000);

  it("al cerrar la conexión se apaga su latido (sin temporizadores huérfanos)", async () => {
    const gw = gateway();
    const { battle } = liveBattle();
    gw.attachBattle("b-close", battle, { spectator: { delaySeconds: 2 }, pollIntervalMs: 10 });
    const { ws } = await connect(gw, "b-close");
    await sleep(300);
    const feed = (gw as any).feeds.get("b-close");
    const [conn] = [...feed.clients];
    expect(conn.heartbeat).not.toBeNull();
    ws.close();
    await sleep(200);
    expect(feed.clients.size).toBe(0);
    expect(conn.heartbeat).toBeNull();
  }, 10_000);

  it("DELAY_ZERO_REGRESSION · delay=0: ni un latido, init con el tick vivo y stream inmediato", async () => {
    const gw = gateway();
    const { battle, producedAt } = liveBattle();
    gw.attachBattle("b-zero", battle, { pollIntervalMs: 10 });
    await sleep(300);
    const { got } = await connect(gw, "b-zero");
    await sleep(800);
    expect(got[0].msg.type).toBe("init");
    expect(got[0].msg.spectator.delaySeconds).toBe(0);
    expect(got[0].msg.spectator).toEqual({ allowFogView: false, delaySeconds: 0, debug: false }); // init de siempre
    expect(got[0].msg.snapshot).not.toBeNull();
    expect(got.filter((g) => g.msg.type === "heartbeat")).toEqual([]);
    const snaps = got.filter((g) => g.msg.type === "snapshot");
    expect(snaps.length).toBeGreaterThan(5);
    for (const s of snaps) expect(s.at - producedAt.get(s.msg.snapshot.tick)!).toBeLessThan(250);
  }, 10_000);
});
