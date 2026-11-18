/**
 * PORTABLE · round-trip E2E del export/import de bots y equipos (scripts/portable) contra la API
 * REAL sobre DOS bases de datos independientes: ORIGEN (con datos) y DESTINO (instalación nueva y
 * vacía con un usuario nuevo). Se compara de forma SEMÁNTICA (código byte a byte, loadout,
 * runtime, equipos y pertenencia), no por texto. Cada `it` nombra el mutante (M#) que mata.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import argon2 from "argon2";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { chmodSync, cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestDb, type TestDbHandle } from "./testing/test-db.js";
import { DEV_PASSWORD, DEV_USERS, seedContent, seedDev } from "./db/seeds/dev.js";
import { tokenFor } from "./testing/helpers.js";
import { createApp } from "./app.js";
import { ApiClient, loadAuth } from "../../../scripts/portable/lib/api.mjs";
import { runExport } from "../../../scripts/portable/lib/export.mjs";
import { runImport } from "../../../scripts/portable/lib/import.mjs";
import { loadoutKey, scanExportDir, sha256Hex, verifyExport } from "../../../scripts/portable/lib/format.mjs";
import { main as cli } from "../../../scripts/portable/portable.mjs";

interface Api {
  server: Server;
  url: string;
}
const listen = (app: Parameters<typeof createServer>[1]): Promise<Api> =>
  new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
  });

const BASE_MODULES = [
  { slot: "drive", moduleId: "movement.tracks@1" },
  { slot: "power", moduleId: "power.battery@1" },
  { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
];
const L_BASE = { name: "Base", catalogVersion: "mvp@1", chassis: "chassis.medium@1", modules: BASE_MODULES };
const L_RADIO = {
  name: "Con radio",
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@1",
  modules: [
    ...BASE_MODULES.map((m) => (m.slot === "power" ? { slot: "power", moduleId: "power.generator@1" } : m)),
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};

// Código sintético (nada del operador real): incluye bytes no UTF-8 y Unicode para probar fidelidad byte a byte.
const code = (tag: string) => Buffer.concat([Buffer.from(`# ${tag} · ñandú ✓\n`), Buffer.from([0, 255, 254, 10, 128]), Buffer.from("print('ok')\n")]);

let A: TestDbHandle;
let B: TestDbHandle;
let apiA: Api;
let apiB: Api;
let tmp: string;
let tokA: string;
let operatorEmail: string;
let operatorId: string;
let clientA: InstanceType<typeof ApiClient>;
let exportDir: string;
let exported: Awaited<ReturnType<typeof runExport>>;
const NEW_EMAIL = "operador.nuevo@example.test";
const NEW_PASSWORD = "contraseña-nueva-del-operador!";
let credFile: string;

async function addVersion(c: InstanceType<typeof ApiClient>, botId: string, rev: number, runtime: "python" | "node", bytes: Buffer, parent?: number) {
  const form = new FormData();
  form.append("runtime", runtime);
  form.append("loadoutRevision", String(rev));
  if (parent) form.append("parentVersion", String(parent));
  form.append("source", new Blob([bytes]), runtime === "python" ? "main.py" : "main.js");
  return c.json("POST", `/bots/${botId}/versions`, { form });
}

async function mkBot(c: InstanceType<typeof ApiClient>, name: string) {
  return c.json("POST", "/bots", { json: { name, visibility: "private" } });
}

const counts = async (h: TestDbHandle) => ({
  bots: Number((await h.db("bots").count({ c: "*" }).first())!.c),
  loadouts: Number((await h.db("bot_loadouts").count({ c: "*" }).first())!.c),
  versions: Number((await h.db("bot_versions").count({ c: "*" }).first())!.c),
  teams: Number((await h.db("teams").count({ c: "*" }).first())!.c),
  teamBots: Number((await h.db("bots").whereNotNull("team_id").count({ c: "*" }).first())!.c),
  builds: Number((await h.db("builds").count({ c: "*" }).first())!.c),
});

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "portable-rt-"));
  A = await startTestDb();
  B = await startTestDb();
  await seedDev(A.db);
  await seedContent(B.db);
  // Usuario NUEVO del destino, promovido a admin (el paso del operador antes de importar).
  const [u] = await B.db("users")
    .insert({ email: NEW_EMAIL, password_hash: await argon2.hash(NEW_PASSWORD, { type: argon2.argon2id }), display_name: "nuevo" })
    .returning("id");
  for (const role of ["user", "developer", "admin"]) await B.db("user_roles").insert({ user_id: u.id, role });
  apiA = await listen(createApp({ db: A.db, anonQuota: { max: 10_000, windowMs: 3600_000 } }));
  apiB = await listen(createApp({ db: B.db, anonQuota: { max: 10_000, windowMs: 3600_000 } }));
  credFile = join(tmp, "cred.json");
  writeFileSync(credFile, JSON.stringify({ email: NEW_EMAIL, password: NEW_PASSWORD }), { mode: 0o600 });
  chmodSync(credFile, 0o600);

  // ------------------------------------------------------------ datos de ORIGEN
  operatorEmail = DEV_USERS.developer;
  operatorId = (await A.db("users").where({ email: operatorEmail }).first()).id;
  tokA = await tokenFor(A.db, operatorEmail);
  clientA = new ApiClient({ baseUrl: apiA.url, auth: { token: tokA } });

  // Bot 1: dos loadouts, v1 python published, v2 node published (hijo de v1, loadout con radio), v3 draft.
  const alfa = await mkBot(clientA, "Alfa Tanque");
  await clientA.json("POST", `/bots/${alfa.id}/loadouts`, { json: L_BASE });
  await clientA.json("POST", `/bots/${alfa.id}/loadouts`, { json: L_RADIO });
  await addVersion(clientA, alfa.id, 1, "python", code("alfa-v1"));
  await addVersion(clientA, alfa.id, 2, "node", code("alfa-v2"), 1);
  await addVersion(clientA, alfa.id, 1, "python", code("alfa-v3-borrador"));
  await A.db("bot_versions").where({ bot_id: alfa.id }).whereIn("version", [1, 2]).update({ state: "published" });
  // Bot 2: sólo borrador.
  const beta = await mkBot(clientA, "Beta Ñandú");
  await clientA.json("POST", `/bots/${beta.id}/loadouts`, { json: L_BASE });
  await addVersion(clientA, beta.id, 1, "python", code("beta-v1"));
  // Bot 3: retirado, con código público.
  const gamma = await mkBot(clientA, "Gamma Retirado");
  await clientA.json("POST", `/bots/${gamma.id}/loadouts`, { json: L_BASE });
  await addVersion(clientA, gamma.id, 1, "node", code("gamma-v1"));
  await A.db("bot_versions").where({ bot_id: gamma.id, version: 1 }).update({ state: "published", code_public: true });
  await clientA.json("PATCH", `/bots/${gamma.id}`, { json: { retired: true } });
  // Escuadra 4v4 con radio.
  const squad: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const b = await mkBot(clientA, `Escuadra ${i}`);
    await clientA.json("POST", `/bots/${b.id}/loadouts`, { json: L_RADIO });
    await addVersion(clientA, b.id, 1, "python", code(`escuadra-${i}`));
    await A.db("bot_versions").where({ bot_id: b.id }).update({ state: "published" });
    squad.push(b.id);
  }
  // Equipos: el 4v4 con radio y otro de 2 con un miembro y un bot AJENOS.
  const rojo = await clientA.json("POST", "/teams", { json: { name: "Equipo Rojo 4v4" } });
  for (const id of squad) await clientA.json("POST", `/teams/${rojo.id}/bots`, { json: { botId: id } });
  const azul = await clientA.json("POST", "/teams", { json: { name: "Equipo Azul" } });
  await clientA.json("POST", `/teams/${azul.id}/bots`, { json: { botId: alfa.id } });
  await clientA.json("POST", `/teams/${azul.id}/bots`, { json: { botId: beta.id } });
  const capEmail = DEV_USERS.team_captain;
  await clientA.json("POST", `/teams/${azul.id}/members`, { json: { email: capEmail } });
  const capClient = new ApiClient({ baseUrl: apiA.url, auth: { token: await tokenFor(A.db, capEmail) } });
  const ajeno = await mkBot(capClient, "Bot Ajeno");
  await capClient.json("POST", `/bots/${ajeno.id}/loadouts`, { json: L_BASE });
  await A.db("bots").where({ id: ajeno.id }).update({ team_id: azul.id });
  // Un equipo ajeno donde el operador sólo es miembro: no es suyo, no se exporta.
  const otro = await capClient.json("POST", "/teams", { json: { name: "Equipo De Otro" } });
  await capClient.json("POST", `/teams/${otro.id}/members`, { json: { email: operatorEmail } });

  // ------------------------------------------------------------ export
  exportDir = join(tmp, "export");
  exported = await runExport({ client: clientA, dest: exportDir, sourceSha: "a".repeat(40), engineVersion: "0.5.0", knownSecrets: [DEV_PASSWORD] });
});

afterAll(async () => {
  for (const a of [apiA, apiB]) await new Promise((r) => a?.server.close(r));
  await A?.stop();
  await B?.stop();
  rmSync(tmp, { recursive: true, force: true });
});

const newClient = () => new ApiClient({ baseUrl: apiB.url, auth: loadAuth({ credentialsFile: credFile }) });

describe("export", () => {
  it("manifest y recuentos: 7 bots, 2 equipos, versiones por política heads", () => {
    const m = exported.manifest;
    expect(m.formatVersion).toBe(1);
    expect(m.engineVersion).toBe("0.5.0");
    expect(m.sourceSha).toBe("a".repeat(40));
    expect(m.counts).toMatchObject({ bots: 7, teams: 2 });
    // Alfa: v2 (cabeza publicada) + v3 (borrador); v1 omitida. Beta: v1 draft. Gamma: v1. 4 escuadra: v1 cada una.
    expect(m.counts.versions).toBe(2 + 1 + 1 + 4);
    expect(m.counts.omittedVersions).toBe(1);
    expect(m.omittedVersions).toEqual([{ bot: "alfa-tanque", version: 1, state: "published", reason: "not_selected_by_policy_heads" }]);
    expect(m.warnings.join("\n")).toMatch(/otros usuarios/);
    expect(m.warnings.join("\n")).toMatch(/no capitán/);
    const v = verifyExport(exportDir);
    expect(v.teams.map((t: { name: string }) => t.name).sort()).toEqual(["Equipo Azul", "Equipo Rojo 4v4"]);
  });

  it("checksums.sha256 verifica con `sha256sum -c`", () => {
    const out = execFileSync("sha256sum", ["-c", "checksums.sha256"], { cwd: exportDir }).toString();
    expect(out).toContain("manifest.json: OK");
    expect(out).not.toMatch(/FAILED/);
  });

  it("M3 · SIN secretos ni datos personales: ni correo, ni ids, ni token, ni contraseña, ni nombres de otros", () => {
    const known = [operatorEmail, operatorId, tokA, DEV_PASSWORD, DEV_USERS.team_captain, "dev-team_captain", "dev-developer", NEW_EMAIL];
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) (e.isDirectory() ? walk(join(d, e.name)) : files.push(join(d, e.name)));
    };
    walk(exportDir);
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(f).toString("latin1");
      for (const k of known) expect(text, `${f} contiene un valor sensible`).not.toContain(k);
    }
    const listed = JSON.parse(readFileSync(join(exportDir, "manifest.json"), "utf8")).files;
    expect(scanExportDir(exportDir, listed, known)).toEqual([]);
    // Ningún UUID en los metadatos (el export no lleva ids internos).
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      expect(readFileSync(f, "utf8")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    }
  });

  it("el código exportado es byte a byte el del origen (incluidos bytes no UTF-8)", () => {
    const bot = JSON.parse(readFileSync(join(exportDir, "bots/alfa-tanque/bot.json"), "utf8"));
    const v2 = bot.versions.find((v: { version: number }) => v.version === 2);
    const bytes = readFileSync(join(exportDir, ...v2.source.file.split("/")));
    expect(bytes.equals(code("alfa-v2"))).toBe(true);
    expect(v2.parentVersion).toBeNull();
    expect(v2.parentVersionOmitted).toBe(1);
    expect(v2.runtime).toBe("node");
    expect(bot.loadouts.map((l: { revision: number }) => l.revision)).toEqual([1, 2]);
  });

  it("el export falla si el directorio no está vacío (no sobrescribe)", async () => {
    await expect(runExport({ client: clientA, dest: exportDir, engineVersion: "0.5.0" })).rejects.toThrow(/no está vacío/);
  });
});

describe("import en una instalación NUEVA y vacía", () => {
  let report: Awaited<ReturnType<typeof runImport>>;
  let afterFirst: Awaited<ReturnType<typeof counts>>;

  it("M2 · un export corrupto falla ANTES de escribir: ni una petición al destino", async () => {
    const bad = join(tmp, "bad");
    cpSync(exportDir, bad, { recursive: true });
    writeFileSync(join(bad, "bots/escuadra-1/versions/v1/source.bin"), "# alterado\n");
    const c = newClient();
    await expect(runImport({ client: c, src: bad, targetEngine: "0.5.0" })).rejects.toThrow(/checksum/i);
    expect(c.requests).toBe(0);
    expect(await counts(B)).toMatchObject({ bots: 0, loadouts: 0, versions: 0, teams: 0 });
  });

  it("--dry-run lee el destino pero no escribe nada (0 escrituras, BD intacta) y planifica todo", async () => {
    const c = newClient();
    const r = await runImport({ client: c, src: exportDir, targetEngine: "0.5.0", dryRun: true });
    expect(r.errors).toEqual([]);
    expect(c.writes).toBe(1); // sólo el POST /auth/login
    expect(await counts(B)).toMatchObject({ bots: 0, loadouts: 0, versions: 0, teams: 0 });
    expect(r.bots).toHaveLength(7);
    expect(r.bots.every((b: { action: string }) => b.action === "created")).toBe(true);
    expect(r.bots.flatMap((b: { versions: { action: string }[] }) => b.versions).every((v) => v.action === "would_create")).toBe(true);
  });

  it("importa bots, loadouts, versiones y equipos con el usuario nuevo (sin publicar nada)", async () => {
    report = await runImport({ client: newClient(), src: exportDir, targetEngine: "0.5.0" });
    expect(report.errors).toEqual([]);
    expect(report.summary).toMatchObject({ bots: { created: 7, reused: 0 }, versions: { created: 8, reused: 0 }, teams: { created: 2, reused: 0 } });
    const me = await B.db("users").where({ email: NEW_EMAIL }).first();
    // Propiedad: todos los bots son del usuario NUEVO; nada se publicó; todo en draft.
    expect((await B.db("bots").select("owner_id")).every((b) => b.owner_id === me.id)).toBe(true);
    expect((await B.db("bot_versions").select("state")).every((v) => v.state === "draft")).toBe(true);
    expect(report.bots.find((b: { slug: string }) => b.slug === "alfa-tanque")!.id).toBeTruthy();
    afterFirst = await counts(B);
    expect(afterFirst).toMatchObject({ bots: 7, versions: 8, teams: 2, teamBots: 6, builds: 0 });
  });

  it("comparación SEMÁNTICA origen→destino: código, runtime, loadout (con radio), padre, retirado y equipos", async () => {
    const cB = newClient();
    const botsB = new Map<string, { id: string }>();
    for (const b of await cB.listAll("/bots", {})) botsB.set(b.name, b);
    for (const slug of readdirSync(join(exportDir, "bots"))) {
      const meta = JSON.parse(readFileSync(join(exportDir, "bots", slug, "bot.json"), "utf8"));
      const tgt = botsB.get(meta.name);
      expect(tgt, `bot ${meta.name} en el destino`).toBeTruthy();
      const loadoutsB = await cB.json("GET", `/bots/${tgt!.id}/loadouts`);
      const versionsB = await cB.json("GET", `/bots/${tgt!.id}/versions`);
      expect(versionsB).toHaveLength(meta.versions.length);
      for (const v of meta.versions) {
        const lo = meta.loadouts.find((l: { revision: number }) => l.revision === v.loadoutRevision);
        const vb = versionsB.find((x: { runtime: string; loadoutRevision: number }) => {
          const l = loadoutsB.find((q: { revision: number }) => q.revision === x.loadoutRevision);
          return x.runtime === v.runtime && l && loadoutKey(l) === loadoutKey(lo);
        });
        expect(vb, `${meta.name} v${v.version}`).toBeTruthy();
        const src = await cB.request("GET", `/bots/${tgt!.id}/versions/${vb.version}/source`);
        expect(sha256Hex(src.bytes)).toBe(v.source.sha256);
        // el origen REAL (no sólo el fichero exportado) coincide con el destino
        const row = await A.db("bots").where({ name: meta.name, owner_id: operatorId }).first();
        const orig = await A.db("bot_versions").where({ bot_id: row.id, version: v.version }).first();
        expect(Buffer.from(orig.source).equals(src.bytes)).toBe(true);
      }
      // loadouts del destino cubren los del origen, con idéntico contenido (también el de radio)
      for (const l of meta.loadouts) expect(loadoutsB.some((q: object) => loadoutKey(q) === loadoutKey(l))).toBe(true);
      const bDetail = await cB.json("GET", `/bots/${tgt!.id}`);
      expect(!!bDetail.retiredAt).toBe(meta.retired);
    }
    const radio = JSON.parse(readFileSync(join(exportDir, "bots/escuadra-1/bot.json"), "utf8")).loadouts[0];
    expect(radio.modules.some((m: { slot: string }) => m.slot === "radio_a")).toBe(true);
    // padre: la v2 de Alfa perdió su padre (omitido) y la v3 no tenía
    const vA = await cB.json("GET", `/bots/${botsB.get("Alfa Tanque")!.id}/versions`);
    expect(vA.every((v: { parentVersion?: number }) => v.parentVersion === undefined)).toBe(true);
    // equipos
    const teamsB = await cB.listAll("/teams");
    const rojo = teamsB.find((t: { name: string }) => t.name === "Equipo Rojo 4v4");
    expect(rojo.isCaptain).toBe(true);
    expect(rojo.bots.map((b: { name: string }) => b.name).sort()).toEqual(["Escuadra 1", "Escuadra 2", "Escuadra 3", "Escuadra 4"]);
    const azul = teamsB.find((t: { name: string }) => t.name === "Equipo Azul");
    expect(azul.bots.map((b: { name: string }) => b.name).sort()).toEqual(["Alfa Tanque", "Beta Ñandú"]); // el bot ajeno NO viaja
    expect(azul.members).toHaveLength(1); // los otros miembros no se migran
    expect(teamsB.some((t: { name: string }) => t.name === "Equipo De Otro")).toBe(false);
  });

  it("M4 · repetir el import es idempotente: nada se duplica y todo sale «reused»", async () => {
    const r2 = await runImport({ client: newClient(), src: exportDir, targetEngine: "0.5.0" });
    expect(r2.errors).toEqual([]);
    expect(r2.summary).toMatchObject({ bots: { created: 0, reused: 7 }, versions: { created: 0, reused: 8 }, teams: { created: 0, reused: 2 } });
    expect(r2.bots.flatMap((b: { loadouts: { action: string }[] }) => b.loadouts).every((l) => l.action === "reused")).toBe(true);
    expect(await counts(B)).toEqual(afterFirst);
  });

  it("informe de correspondencias slug → id nuevo (y el CLI lo escribe con permisos 0600)", async () => {
    expect(report.bots.map((b: { slug: string }) => b.slug).sort()).toContain("escuadra-4");
    expect(report.bots.every((b: { id: string }) => /^[0-9a-f-]{36}$/.test(b.id))).toBe(true);
    const rep = join(tmp, "report.json");
    const out: string[] = [];
    const rc = await cli(["import", "--from", exportDir, "--target-engine", "0.5.0", "--api-url", apiB.url, "--credentials-file", credFile, "--report", rep], {
      out: (s: string) => out.push(s),
      err: () => {},
    });
    expect(rc).toBe(0);
    expect(statSync(rep).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(rep, "utf8")).summary.bots).toEqual({ created: 0, reused: 7 });
    expect(out.join("\n")).toMatch(/IMPORT OK/);
  });

  it("--submit deja el REBUILD listo: encola la validación de lo que estaba publicado, sin publicar", async () => {
    const before = await counts(B);
    const r = await runImport({ client: newClient(), src: exportDir, targetEngine: "0.5.0", submit: true });
    expect(r.errors).toEqual([]);
    // publicadas en origen: Alfa v2, Gamma v1, 4 de la escuadra = 6
    const queued = r.bots.flatMap((b: { versions: { queued?: boolean }[] }) => b.versions).filter((v) => v.queued);
    expect(queued).toHaveLength(6);
    expect((await counts(B)).builds).toBe(before.builds + 6);
    expect((await B.db("bot_versions").where({ state: "published" }).count({ c: "*" }).first())!.c).toBe("0");
    // y un tercer import no vuelve a encolar (ya no están en draft)
    const r3 = await runImport({ client: newClient(), src: exportDir, targetEngine: "0.5.0", submit: true });
    expect(r3.bots.flatMap((b: { versions: { queued?: boolean }[] }) => b.versions).filter((v) => v.queued)).toHaveLength(0);
    expect((await counts(B)).builds).toBe(before.builds + 6);
  });

  it("M5 · un equipo cuyo bot no se pudo importar queda marcado como incompleto (no se oculta)", async () => {
    const bad = join(tmp, "bad-name");
    cpSync(exportDir, bad, { recursive: true });
    const f = join(bad, "bots/beta-nandu/bot.json");
    const meta = JSON.parse(readFileSync(f, "utf8"));
    meta.name = "N".repeat(60); // la API rechaza nombres > 48: el bot no se crea
    writeFileSync(f, JSON.stringify(meta, null, 2) + "\n");
    // re-sellar manifest + checksums para que la verificación pase y se ejercite el import
    const m = JSON.parse(readFileSync(join(bad, "manifest.json"), "utf8"));
    for (const e of m.files) {
      const b = readFileSync(join(bad, ...e.path.split("/")));
      e.sha256 = sha256Hex(b);
      e.bytes = b.length;
    }
    const mt = JSON.stringify(m, null, 2) + "\n";
    writeFileSync(join(bad, "manifest.json"), mt);
    const sums = [...m.files.map((e: { sha256: string; path: string }) => `${e.sha256}  ${e.path}`), `${sha256Hex(Buffer.from(mt))}  manifest.json`];
    writeFileSync(join(bad, "checksums.sha256"), sums.join("\n") + "\n");
    const r = await runImport({ client: newClient(), src: bad, targetEngine: "0.5.0" });
    expect(r.errors.some((e: { scope: string }) => e.scope === "bot:beta-nandu")).toBe(true);
    const team = r.errors.filter((e: { scope: string }) => e.scope === "team:equipo-azul");
    expect(team.length).toBeGreaterThan(0);
    expect(team[0].message).toMatch(/incompleto/);
  });

  it("un loadout que el validador de la aplicación rechaza se informa y no cuelga el resto", async () => {
    const bad = join(tmp, "bad-loadout");
    cpSync(exportDir, bad, { recursive: true });
    const f = join(bad, "bots/gamma-retirado/bot.json");
    const meta = JSON.parse(readFileSync(f, "utf8"));
    meta.name = "Gamma Retirado 2";
    meta.loadouts[0].modules = [{ slot: "drive", moduleId: "movement.no-existe@1" }];
    writeFileSync(f, JSON.stringify(meta, null, 2) + "\n");
    const m = JSON.parse(readFileSync(join(bad, "manifest.json"), "utf8"));
    for (const e of m.files) {
      const b = readFileSync(join(bad, ...e.path.split("/")));
      e.sha256 = sha256Hex(b);
      e.bytes = b.length;
    }
    const mt = JSON.stringify(m, null, 2) + "\n";
    writeFileSync(join(bad, "manifest.json"), mt);
    writeFileSync(
      join(bad, "checksums.sha256"),
      [...m.files.map((e: { sha256: string; path: string }) => `${e.sha256}  ${e.path}`), `${sha256Hex(Buffer.from(mt))}  manifest.json`].join("\n") + "\n",
    );
    const r = await runImport({ client: newClient(), src: bad, targetEngine: "0.5.0" });
    const e = r.errors.filter((x: { scope: string }) => x.scope === "bot:gamma-retirado");
    expect(e.length).toBeGreaterThan(0);
    expect(e.map((x: { message: string }) => x.message).join(" ")).toMatch(/loadout/);
    expect(r.bots.find((b: { slug: string }) => b.slug === "escuadra-1")!.errors).toEqual([]);
  });

  it("--restore-visibility restaura visibilidad y código público; por defecto todo queda privado", async () => {
    const cB = newClient();
    const gamma = (await cB.listAll("/bots", {})).find((b: { name: string }) => b.name === "Gamma Retirado");
    expect(gamma.visibility).toBe("private");
    const d0 = await cB.json("GET", `/bots/${gamma.id}/versions/1`);
    expect(d0.codePublic).toBe(false);
    const r = await runImport({ client: newClient(), src: exportDir, targetEngine: "0.5.0", restoreVisibility: true });
    expect(r.errors).toEqual([]);
    const d1 = await newClient().json("GET", `/bots/${gamma.id}/versions/1`);
    expect(d1.codePublic).toBe(true);
  });
});
