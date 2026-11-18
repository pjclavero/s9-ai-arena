#!/usr/bin/env node
/**
 * Ensayo E2E (VM de pruebas) · puebla el ORIGEN con bots sintéticos variados y 2 equipos (uno 4v4 con
 * radio) a través de la API real. Uso: S9_API_URL=… node populate.mjs <credenciales.json 0600>
 * Los estados published/draft los fija run.sh con SQL (la API sólo llega a draft sin el worker).
 */
import { ApiClient, loadAuth } from "../lib/api.mjs";

const base = [
  { slot: "drive", moduleId: "movement.tracks@1" },
  { slot: "power", moduleId: "power.battery@1" },
  { slot: "sensor_a", moduleId: "sensor.lidar360@1" },
  { slot: "turret_main", moduleId: "weapon.cannon@1", ammo: "ammo.ap@1" },
  { slot: "armor_front", moduleId: "armor.steel_front@1" },
];
const L_BASE = { name: "Base", catalogVersion: "mvp@1", chassis: "chassis.medium@1", modules: base };
const L_RADIO = {
  name: "Con radio",
  catalogVersion: "mvp@1",
  chassis: "chassis.medium@1",
  modules: [
    ...base.map((m) => (m.slot === "power" ? { slot: "power", moduleId: "power.generator@1" } : m)),
    { slot: "radio_a", moduleId: "radio.short@1" },
  ],
};
const code = (tag) =>
  Buffer.concat([
    Buffer.from(`# ${tag} · ñandú ✓\n`),
    Buffer.from([0, 255, 254, 10, 128]),
    Buffer.from("print('ok')\n"),
  ]);

const c = new ApiClient({ baseUrl: process.env.S9_API_URL, auth: loadAuth({ credentialsFile: process.argv[2] }) });
const bot = (name) => c.json("POST", "/bots", { json: { name, visibility: "private" } });
const lo = (id, l) => c.json("POST", `/bots/${id}/loadouts`, { json: l });
const ver = (id, rev, runtime, bytes, parent) => {
  const f = new FormData();
  f.append("runtime", runtime);
  f.append("loadoutRevision", String(rev));
  if (parent) f.append("parentVersion", String(parent));
  f.append("source", new Blob([new Uint8Array(bytes)]), runtime === "python" ? "main.py" : "main.js");
  return c.json("POST", `/bots/${id}/versions`, { form: f });
};

const alfa = await bot("Alfa Tanque");
await lo(alfa.id, L_BASE);
await lo(alfa.id, L_RADIO);
await ver(alfa.id, 1, "python", code("alfa-v1"));
await ver(alfa.id, 2, "node", code("alfa-v2"), 1);
await ver(alfa.id, 1, "python", code("alfa-v3-borrador"));
const beta = await bot("Beta Ñandú");
await lo(beta.id, L_BASE);
await ver(beta.id, 1, "python", code("beta-v1"));
const gamma = await bot("Gamma Retirado");
await lo(gamma.id, L_BASE);
await ver(gamma.id, 1, "node", code("gamma-v1"));
await c.json("PATCH", `/bots/${gamma.id}`, { json: { retired: true } });
const squad = [];
for (let i = 1; i <= 4; i++) {
  const b = await bot(`Escuadra ${i}`);
  await lo(b.id, L_RADIO);
  await ver(b.id, 1, "python", code(`escuadra-${i}`));
  squad.push(b.id);
}
const rojo = await c.json("POST", "/teams", { json: { name: "Equipo Rojo 4v4" } });
for (const id of squad) await c.json("POST", `/teams/${rojo.id}/bots`, { json: { botId: id } });
const azul = await c.json("POST", "/teams", { json: { name: "Equipo Azul" } });
for (const id of [alfa.id, beta.id]) await c.json("POST", `/teams/${azul.id}/bots`, { json: { botId: id } });
console.log("populate OK: 7 bots, 2 equipos");
