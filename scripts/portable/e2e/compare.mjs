#!/usr/bin/env node
/**
 * Ensayo E2E · compara SEMÁNTICAMENTE origen y destino a través de sus APIs: por cada bot, el conjunto
 * de (runtime, sha256 del código, loadout canónico) de las versiones que la política `heads` exporta
 * debe ser EXACTAMENTE el de las versiones del destino; también retirado y composición de equipos.
 * Uso: node compare.mjs <urlOrigen> <credOrigen> <urlDestino> <credDestino>
 */
import { ApiClient, loadAuth } from "../lib/api.mjs";
import { loadoutKey, selectVersions, sha256Hex } from "../lib/format.mjs";

const [urlA, credA, urlB, credB] = process.argv.slice(2);
const A = new ApiClient({ baseUrl: urlA, auth: loadAuth({ credentialsFile: credA }) });
const B = new ApiClient({ baseUrl: urlB, auth: loadAuth({ credentialsFile: credB }) });

async function snapshot(c, heads) {
  const me = await c.json("GET", "/users/me");
  const bots = (await c.listAll("/bots", { ownerId: me.id })).filter((b) => b.ownerId === me.id);
  const out = {};
  for (const b of bots) {
    const los = await c.json("GET", `/bots/${b.id}/loadouts`);
    let vs = await c.json("GET", `/bots/${b.id}/versions`);
    if (heads) vs = selectVersions(vs, "heads").selected;
    const set = [];
    for (const v of vs) {
      const src = await c.request("GET", `/bots/${b.id}/versions/${v.version}/source`);
      set.push(`${v.runtime}|${sha256Hex(src.bytes)}|${loadoutKey(los.find((l) => l.revision === v.loadoutRevision))}`);
    }
    out[b.name] = { retired: !!b.retiredAt, versions: set.sort() };
  }
  const teams = {};
  for (const t of (await c.listAll("/teams")).filter((t) => t.isCaptain)) {
    teams[t.name] = (t.bots ?? []).map((x) => x.name).sort();
  }
  return { bots: out, teams };
}

const a = await snapshot(A, true);
const b = await snapshot(B, false);
const canon = (v) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1)))
      : x,
  );
const ja = canon(a);
const jb = canon(b);
if (ja !== jb) {
  console.error("COMPARACION DISTINTA\norigen :", ja, "\ndestino:", jb);
  process.exit(1);
}
const nv = Object.values(a.bots).reduce((n, x) => n + x.versions.length, 0);
console.log(
  `COMPARACION IGUAL · ${Object.keys(a.bots).length} bots · ${nv} versiones · ${Object.keys(a.teams).length} equipos`,
);
