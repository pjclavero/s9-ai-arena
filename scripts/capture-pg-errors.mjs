#!/usr/bin/env node
// Release 0.5.0 · PR A · captura de las formas REALES de error de pg/knex ante una BD caída.
//
// Genera `apps/tournament-worker/src/testing/fixtures/real-db-errors.json`, que usa
// `battle-timeout-classification.test.ts`. Los fixtures NO se escriben a mano: salen de errores
// capturados con `pg` y `knex` reales (Node de la versión en uso) contra:
//   · un puerto IPv4 cerrado                       (127.0.0.1)
//   · `localhost` dual-stack                        (AggregateError)
//   · un backend terminado (pg_terminate_backend), con consulta en vuelo y con el cliente ocioso
//   · el servidor Postgres muerto con la conexión abierta (docker kill)
//   · un DSN POR NOMBRE (`postgres`) que Node resuelve a una IP: nada escucha / contenedor parado
//   · 57014 (statement_timeout)
//
// Necesita Docker (postgres:16-alpine ya descargada) y se ejecuta en VM111:
//   node scripts/capture-pg-errors.mjs <salida.json>
// Las partes «por nombre» corren DENTRO de una red de Docker (el nombre `postgres` lo resuelve el
// DNS del propio Docker, igual que en producción): se lanza este mismo script en un contenedor con
// `--inner <caso>`.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { connect as netConnect, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import pg from "pg";
import knexMod from "knex";

const knexFactory = knexMod.default ?? knexMod;
const AQUI = dirname(fileURLToPath(import.meta.url));
const PASS = "capture-only";

/** Serializa un error con TODO lo que el clasificador puede mirar (y nada más). */
function forma(e) {
  const o = {
    ctor: e?.constructor?.name,
    name: e?.name,
    code: e?.code,
    errno: e?.errno,
    syscall: e?.syscall,
    address: e?.address,
    port: e?.port,
    hostname: e?.hostname,
    message: e?.message,
    // sólo las rutas de la pila (sin números de línea ni rutas del repo): lo que importa es si
    // pasa por pg/pg-pool/knex/tarn o sólo por node:net
    stackFrames: String(e?.stack ?? "")
      .split("\n")
      .slice(1)
      .map((l) => l.trim().replace(/^at /, "").replace(/\(?(?:file:\/\/)?\/[^)]*?node_modules\//, "(node_modules/").replace(/:\d+:\d+\)?$/, ")"))
      .slice(0, 8),
    hasCause: e?.cause !== undefined,
  };
  if (e?.cause) o.cause = forma(e.cause);
  if (Array.isArray(e?.errors)) o.errors = e.errors.map(forma);
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

async function pgConnect(cfg) {
  const c = new pg.Client({ user: "arena", password: PASS, database: "arena", connectionTimeoutMillis: 4000, ...cfg });
  try {
    await c.connect();
    await c.end();
    return { ok: true };
  } catch (e) {
    return forma(e);
  }
}

async function knexSelect(cfg) {
  const k = knexFactory({
    client: "pg",
    connection: { user: "arena", password: PASS, database: "arena", ...cfg },
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 4000,
  });
  try {
    await k.raw("select 1");
    return { ok: true };
  } catch (e) {
    return forma(e);
  } finally {
    await k.destroy().catch(() => {});
  }
}

async function puertoCerrado() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();
const dockerOk = (args) => spawnSync("docker", args, { encoding: "utf8" });

async function esperarPg(host, port) {
  for (let i = 0; i < 60; i++) {
    const r = await pgConnect({ host, port });
    if (r.ok) return;
    await new Promise((r2) => setTimeout(r2, 500));
  }
  throw new Error("postgres no arrancó");
}

/** Casos que se ejecutan en el host contra 127.0.0.1 / localhost y un Postgres real publicado. */
async function casosHost(out) {
  const cerrado = await puertoCerrado();
  out.ipv4_cerrado = { pg: await pgConnect({ host: "127.0.0.1", port: cerrado }), knex: await knexSelect({ host: "127.0.0.1", port: cerrado }) };
  out.localhost_dualstack = { pg: await pgConnect({ host: "localhost", port: cerrado }), knex: await knexSelect({ host: "localhost", port: cerrado }) };

  // un nombre que no resuelve (DNS): ENOTFOUND / EAI_AGAIN según el resolutor
  out.dns_no_resuelve = { pg: await pgConnect({ host: "no-existe.invalid", port: 5432 }), knex: await knexSelect({ host: "no-existe.invalid", port: 5432 }) };

  // un par TCP que RESETEA (RST) nada más aceptar: forma de un servidor que revienta con la conexión a medias
  {
    const srv = createServer((sock) => sock.resetAndDestroy());
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const pr = srv.address().port;
    out.reset_durante_conexion = { pg: await pgConnect({ host: "127.0.0.1", port: pr }), knex: await knexSelect({ host: "127.0.0.1", port: pr }) };
    await new Promise((r) => srv.close(r));
  }

  const nombre = `s9cap-pg-${process.pid}`;
  dockerOk(["rm", "-f", nombre]);
  sh("docker", ["run", "-d", "--name", nombre, "-e", `POSTGRES_PASSWORD=${PASS}`, "-e", "POSTGRES_USER=arena", "-e", "POSTGRES_DB=arena", "-p", "127.0.0.1::5432", "postgres:16-alpine"]);
  try {
    const mapeo = sh("docker", ["port", nombre, "5432/tcp"]); // 127.0.0.1:PUERTO
    const port = Number(mapeo.split(":").pop());
    await esperarPg("127.0.0.1", port);

    // (1) backend terminado con una consulta en vuelo
    {
      const victima = new pg.Client({ host: "127.0.0.1", port, user: "arena", password: PASS, database: "arena" });
      let eventoVictima;
      victima.on("error", (e) => (eventoVictima = forma(e)));
      await victima.connect();
      const pid = (await victima.query("select pg_backend_pid() as pid")).rows[0].pid;
      const admin = new pg.Client({ host: "127.0.0.1", port, user: "arena", password: PASS, database: "arena" });
      admin.on("error", () => {});
      await admin.connect();
      const enVuelo = victima.query("select pg_sleep(30)").then(
        () => ({ ok: true }),
        (e) => forma(e),
      );
      await new Promise((r) => setTimeout(r, 400));
      await admin.query("select pg_terminate_backend($1)", [pid]);
      out.backend_terminado_en_vuelo = { pg: await enVuelo, evento_error_del_cliente: eventoVictima };
      await victima.end().catch(() => {});
      // (2) backend terminado con el cliente OCIOSO: el error llega por el evento 'error'
      const ocioso = new pg.Client({ host: "127.0.0.1", port, user: "arena", password: PASS, database: "arena" });
      await ocioso.connect();
      const pid2 = (await ocioso.query("select pg_backend_pid() as pid")).rows[0].pid;
      const evento = new Promise((res) => ocioso.on("error", (e) => res(forma(e))));
      await admin.query("select pg_terminate_backend($1)", [pid2]);
      out.backend_terminado_ocioso = { pg: await evento };
      // (3) la siguiente consulta sobre ese cliente ya muerto
      out.consulta_sobre_cliente_muerto = { pg: await ocioso.query("select 1").then(() => ({ ok: true }), (e) => forma(e)) };
      // (4) 57014: statement_timeout real
      const lento = new pg.Client({ host: "127.0.0.1", port, user: "arena", password: PASS, database: "arena", statement_timeout: 300 });
      lento.on("error", () => {});
      await lento.connect();
      out.statement_timeout = { pg: await lento.query("select pg_sleep(5)").then(() => ({ ok: true }), (e) => forma(e)) };
      await lento.end().catch(() => {});
      // knex: pool con una conexión terminada
      const k = knexFactory({ client: "pg", connection: { host: "127.0.0.1", port, user: "arena", password: PASS, database: "arena" }, pool: { min: 1, max: 1 }, acquireConnectionTimeout: 4000 });
      await k.raw("select 1");
      const pidK = (await k.raw("select pg_backend_pid() as pid")).rows[0].pid;
      await admin.query("select pg_terminate_backend($1)", [pidK]);
      await new Promise((r) => setTimeout(r, 300));
      out.backend_terminado_knex = { knex: await k.raw("select 1").then(() => ({ ok: true }), (e) => forma(e)) };
      await k.destroy().catch(() => {});
      await admin.end().catch(() => {});
    }

    // (4b) RST sobre una conexión ya establecida: un proxy TCP transparente que resetea el lado del cliente
    {
      const socks = new Set();
      const proxy = createServer((cl) => {
        const up = netConnect(port, "127.0.0.1");
        socks.add(cl);
        cl.on("error", () => {});
        up.on("error", () => {});
        cl.pipe(up);
        up.pipe(cl);
      });
      await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
      const pp = proxy.address().port;
      const resetear = () => {
        for (const x of socks) x.resetAndDestroy();
        socks.clear();
      };
      const cEnVuelo = new pg.Client({ host: "127.0.0.1", port: pp, user: "arena", password: PASS, database: "arena" });
      let evEnVuelo;
      cEnVuelo.on("error", (e) => (evEnVuelo = forma(e)));
      await cEnVuelo.connect();
      const enVuelo = cEnVuelo.query("select pg_sleep(30)").then(() => ({ ok: true }), (e) => forma(e));
      await new Promise((r) => setTimeout(r, 400));
      resetear();
      out.reset_en_vuelo = { pg: await enVuelo, evento_error_del_cliente: evEnVuelo };
      const cOcioso = new pg.Client({ host: "127.0.0.1", port: pp, user: "arena", password: PASS, database: "arena" });
      const evOcioso = new Promise((res) => cOcioso.on("error", (e) => res(forma(e))));
      await cOcioso.connect();
      resetear();
      out.reset_ocioso = { evento_error_del_cliente: await evOcioso };
      const k = knexFactory({ client: "pg", connection: { host: "127.0.0.1", port: pp, user: "arena", password: PASS, database: "arena" }, pool: { min: 1, max: 1 }, acquireConnectionTimeout: 4000 });
      await k.raw("select 1");
      const enVueloK = k.raw("select pg_sleep(30)").then(() => ({ ok: true }), (e) => forma(e));
      await new Promise((r) => setTimeout(r, 400));
      resetear();
      out.reset_en_vuelo_knex = { knex: await enVueloK };
      await k.destroy().catch(() => {});
      await new Promise((r) => proxy.close(r));
    }

    // (5) el servidor muere (docker kill) con una conexión abierta y una consulta en vuelo
    {
      const c = new pg.Client({ host: "127.0.0.1", port, user: "arena", password: PASS, database: "arena" });
      let eventoC;
      c.on("error", (e) => (eventoC = forma(e)));
      await c.connect();
      const enVuelo = c.query("select pg_sleep(30)").then(
        () => ({ ok: true }),
        (e) => forma(e),
      );
      await new Promise((r) => setTimeout(r, 400));
      dockerOk(["kill", nombre]);
      out.servidor_muerto_en_vuelo = { pg: await enVuelo, evento_error_del_cliente: eventoC };
      await c.end().catch(() => {});
      // y la reconexión contra el puerto publicado, ya sin servidor
      out.servidor_muerto_reconexion = { pg: await pgConnect({ host: "127.0.0.1", port }), knex: await knexSelect({ host: "127.0.0.1", port }) };
    }
  } finally {
    dockerOk(["rm", "-f", nombre]);
  }
}

/** Casos por NOMBRE: se ejecutan dentro de una red de Docker donde `postgres` lo resuelve el DNS de Docker. */
async function casosPorNombre(out, nodeBin, raizRepo) {
  const red = `s9cap-net-${process.pid}`;
  dockerOk(["network", "rm", red]);
  sh("docker", ["network", "create", red]);
  const argsInner = (caso) => ["run", "--rm", "--network", red, "-v", `${nodeBin}:/node:ro`, "-v", `${raizRepo}:/repo:ro`, "-w", "/repo", "debian:stable-slim", "/node/bin/node", "scripts/capture-pg-errors.mjs", "--inner", caso];
  const interno = (caso) => {
    const r = spawnSync("docker", argsInner(caso), { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`inner ${caso} rc=${r.status}: ${r.stderr}`);
    return JSON.parse(r.stdout.trim().split("\n").pop());
  };
  /** Lanza el caso 'matar', espera a que avise (LISTO) y mata el contenedor `postgres` por debajo. */
  const internoMatando = (caso, matar) =>
    new Promise((res, rej) => {
      const p = spawn("docker", argsInner(caso));
      let so = "";
      let se = "";
      p.stdout.on("data", (d) => (so += d));
      p.stderr.on("data", (d) => {
        se += d;
        if (se.includes("LISTO") && !p.matado) {
          p.matado = true;
          setTimeout(() => matar(), 500);
        }
      });
      p.on("close", (rc) => (rc === 0 ? res(JSON.parse(so.trim().split("\n").pop())) : rej(new Error(`inner ${caso} rc=${rc}: ${se}`))));
    });
  try {
    // (a) contenedor `postgres` vivo pero sin nada escuchando en 5432 (arranque/reinicio de la BD)
    sh("docker", ["run", "-d", "--name", "postgres", "--network", red, "debian:stable-slim", "sleep", "600"]);
    out.nombre_sin_escucha = interno("conectar");
    dockerOk(["rm", "-f", "postgres"]);
    // (b) contenedor `postgres` inexistente (parado): el nombre ya no resuelve
    out.nombre_no_resuelve = interno("conectar");
    // (c) Postgres real parado con el pool de knex abierto, por nombre
    sh("docker", ["run", "-d", "--name", "postgres", "--network", red, "-e", `POSTGRES_PASSWORD=${PASS}`, "-e", "POSTGRES_USER=arena", "-e", "POSTGRES_DB=arena", "postgres:16-alpine"]);
    out.nombre_servidor_matado_en_vuelo = await internoMatando("matar", () => dockerOk(["kill", "postgres"]));
  } finally {
    dockerOk(["rm", "-f", "postgres"]);
    dockerOk(["network", "rm", red]);
  }
}

async function interno(caso) {
  const host = "postgres";
  if (caso === "conectar") {
    console.log(JSON.stringify({ pg: await pgConnect({ host, port: 5432 }), knex: await knexSelect({ host, port: 5432 }) }));
    return;
  }
  // 'matar': espera a que el Postgres por nombre acepte, abre cliente y pool, y pide a Docker
  // (desde fuera) que lo mate vía fichero testigo; aquí sólo simulamos con un bucle de espera.
  await esperarPg(host, 5432);
  const c = new pg.Client({ host, port: 5432, user: "arena", password: PASS, database: "arena" });
  let evento;
  c.on("error", (e) => (evento = forma(e)));
  await c.connect();
  const k = knexFactory({ client: "pg", connection: { host, port: 5432, user: "arena", password: PASS, database: "arena" }, pool: { min: 1, max: 1 }, acquireConnectionTimeout: 4000 });
  await k.raw("select 1");
  const enVuelo = c.query("select pg_sleep(60)").then(() => ({ ok: true }), (e) => forma(e));
  console.error("LISTO");
  const pg1 = await enVuelo;
  await new Promise((r) => setTimeout(r, 500));
  const rec = await pgConnect({ host, port: 5432 });
  const rk = await k.raw("select 1").then(() => ({ ok: true }), (e) => forma(e));
  console.log(JSON.stringify({ en_vuelo: pg1, evento_error_del_cliente: evento, reconexion_pg: rec, knex_tras_muerte: rk }));
  await k.destroy().catch(() => {});
}

async function main() {
  const i = process.argv.indexOf("--inner");
  if (i > 0) return interno(process.argv[i + 1]);
  const salida = process.argv[2];
  if (!salida) throw new Error("uso: capture-pg-errors.mjs <salida.json>");
  const out = { _meta: { node: process.version, pg: pg.Client ? "pg" : "?", generado: "por scripts/capture-pg-errors.mjs" } };
  await casosHost(out);
  await casosPorNombre(out, resolve(dirname(process.execPath), ".."), resolve(AQUI, ".."));
  writeFileSync(salida, JSON.stringify(out, null, 2) + "\n");
  console.log("escrito", salida);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
