#!/usr/bin/env node
/**
 * RC2 DEV-CI · C3/C4 — recorrido de USUARIO por la API PÚBLICA (a través del gateway del
 * stack Compose), sin atajos: nada de SQL, ni seed, ni workers en proceso.
 *
 *   C3 build:   registro → bot → loadout → código pegado → submit → la cola `jobs` la
 *               consume el bot-build-worker (CONTENEDOR) → su sandbox pide el contenedor
 *               al s9-docker-proxy por la red `bot-control` → Docker → runtime fijado →
 *               artefacto firmado → validated → publish → published. Dos bots.
 *   C4 batalla: mapa propio publicado (geometría de mvp-arena-01, modo deathmatch) →
 *               POST /battles → el tournament-worker (CONTENEDOR, DOCKER_PROXY_URL fijado
 *               por el job) reclama run_battle → proxy → contenedores de los bots →
 *               motor → finished → ganador → stats → replay por la API autorizada.
 *
 * Los bots son distinguibles (los mismos del golden y de container-battle-e2e.test.ts):
 * el Artillero dispara a todo contacto de radar, el Pacifista nunca dispara. Que gane red
 * con disparos > 0 y blue tenga 0 intentos prueba que corrió SU código.
 *
 * Uso: node flow.mjs <base-url-del-gateway> <fichero-salida.json>
 * Escribe SIEMPRE el JSON de salida (también en fallo, con `error` y la fase); rc 0 sólo
 * si el recorrido entero se cumplió.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [base, outFile] = process.argv.slice(2);
if (!base || !outFile) {
  console.error("uso: flow.mjs <base-url> <salida.json>");
  process.exit(2);
}
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const API = `${base.replace(/\/$/, "")}/api/v1`;

const ARTILLERO = `from arena_sdk import ArenaBot, angle_diff, angle_to

WAYPOINTS = [(30.0, 64.0), (88.0, 64.0), (100.0, 40.0)]


class Artillero(ArenaBot):
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.wp = 0

    def on_observation(self, observation):
        me = observation["self"]
        pos = me["position"]
        contacts = [c for r in observation.get("sensors", {}).get("radar", []) for c in r.get("contacts", [])]
        enemies = [c for c in contacts if not c.get("team")]
        if enemies:
            t = min(enemies, key=lambda c: (c["position"]["x"] - pos["x"]) ** 2 + (c["position"]["y"] - pos["y"]) ** 2)
            turn = angle_diff(me["heading"], angle_to(pos, t["position"]))
            return {
                "move": {"throttle": 0.3, "steer": max(-1.0, min(1.0, turn * 1.5))},
                "turret": {"targetPoint": t["position"]},
                "fire": ["turret_main"],
            }
        tx, ty = WAYPOINTS[min(self.wp, len(WAYPOINTS) - 1)]
        if (tx - pos["x"]) ** 2 + (ty - pos["y"]) ** 2 < 16 and self.wp < len(WAYPOINTS) - 1:
            self.wp += 1
        turn = angle_diff(me["heading"], angle_to(pos, {"x": tx, "y": ty}))
        return {"move": {"throttle": 0.9 if abs(turn) < 1.0 else 0.3, "steer": max(-1.0, min(1.0, turn * 2.0))}}
`;

const PACIFISTA = `from arena_sdk import ArenaBot


class Pacifista(ArenaBot):
    def on_observation(self, observation):
        return {"move": {"throttle": 0.0, "steer": 0.0}}
`;

/** Loadout con RADAR (el de ejemplo lleva lidar, que no ve vehículos) y ruedas (legal en energía). */
function radarLoadout() {
  const b = JSON.parse(
    readFileSync(join(REPO, "packages", "module-catalog", "examples", "loadout-medium-gunner.json"), "utf8"),
  );
  return {
    catalogVersion: b.catalogVersion,
    chassis: b.chassis,
    modules: b.modules.map((m) =>
      m.slot === "sensor_a"
        ? { ...m, moduleId: "sensor.radar@1" }
        : m.slot === "drive"
          ? { ...m, moduleId: "movement.wheels@1" }
          : m,
    ),
  };
}

const out = { base, startedAt: new Date().toISOString(), phase: "init", bots: {}, battle: null, error: null };
const save = () => writeFileSync(outFile, JSON.stringify(out, null, 2));
let token = "";

async function call(method, path, { json, form, expect = [200], timeoutMs = 30_000 } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) body = form;
  const res = await fetch(`${API}${path}`, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 300) };
  }
  if (!expect.includes(res.status)) {
    throw new Error(`${method} ${path} → ${res.status} (esperado ${expect.join("/")}): ${text.slice(0, 400)}`);
  }
  return data;
}

async function poll(what, fn, done, { timeoutMs, everyMs = 3000 }) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    last = await fn();
    if (done(last)) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`${what}: no terminó en ${timeoutMs} ms (último estado: ${JSON.stringify(last).slice(0, 400)})`);
}

async function publishedBot(key, name, code) {
  out.phase = `build:${key}`;
  const bot = await call("POST", "/bots", { json: { name }, expect: [201] });
  const ld = await call("POST", `/bots/${bot.id}/loadouts`, { json: radarLoadout(), expect: [201] });
  const fd = new FormData();
  fd.append("source", new Blob([code], { type: "text/plain" }), "bot.py");
  fd.append("runtime", "python");
  fd.append("loadoutRevision", String(ld.revision ?? 1));
  const v = await call("POST", `/bots/${bot.id}/versions`, { form: fd, expect: [201] });
  const submit = await call("POST", `/bots/${bot.id}/versions/${v.version}/actions/submit`, { expect: [202] });
  const rec = { botId: bot.id, version: v.version, buildId: submit.id, submitStatus: submit.status };
  out.bots[key] = rec;
  save();
  const build = await poll(
    `build ${key}`,
    () => call("GET", `/builds/${submit.id}`),
    (b) => b && ["passed", "failed", "needs_review", "error"].includes(b.status),
    { timeoutMs: 360_000 },
  );
  rec.buildStatus = build.status;
  rec.stages = (build.stages ?? []).map((s) => ({ name: s.name, status: s.status }));
  const proto = (build.stages ?? []).find((s) => s.name === "protocol_test");
  rec.protocolTestPosture = /postura del contenedor conforme/.test((proto?.logs ?? []).join("\n"));
  const detail = await call("GET", `/bots/${bot.id}/versions/${v.version}`);
  if (build.status !== "passed") {
    // C9 · diagnóstico SIN secretos: motivo de rechazo de la versión y logs de cada etapa
    // (son los del sandbox: stderr del bot y del bootstrap del runtime).
    rec.rejectionReason = detail.rejectionReason ?? detail.rejection_reason ?? null;
    rec.versionState = detail.state;
    rec.stageLogs = (build.stages ?? []).map((s) => ({ name: s.name, logs: (s.logs ?? []).slice(-20) }));
    save();
    throw new Error(`build ${key} terminó en ${build.status}: ${rec.rejectionReason ?? JSON.stringify(rec.stages)}`);
  }
  rec.stateBeforePublish = detail.state;
  rec.artifactBuildId = detail.artifact?.buildId ?? null;
  const pub = await call("POST", `/bots/${bot.id}/versions/${v.version}/actions/publish`, {
    json: { codePublic: false },
  });
  rec.state = pub.state;
  if (pub.state !== "published") throw new Error(`bot ${key}: estado tras publicar ${pub.state}`);
  save();
  return rec;
}

async function main() {
  const stamp = Date.now().toString(36);
  out.phase = "register";
  const email = `rc2ci-${randomUUID().slice(0, 8)}@example.internal`;
  const password = `rc2ci-${randomUUID()}`;
  await call("POST", "/auth/register", { json: { email, password, displayName: "RC2 CI" }, expect: [200, 201] });
  const tokens = await call("POST", "/auth/login", { json: { email, password } });
  token = tokens.accessToken;
  if (!token) throw new Error("login sin accessToken");

  const a = await publishedBot("red", `rc2ci-artillero-${stamp}`, ARTILLERO);
  const b = await publishedBot("blue", `rc2ci-pacifista-${stamp}`, PACIFISTA);

  out.phase = "map";
  const mapBase = await call("GET", "/maps/mvp-arena-01/versions/1/content");
  const content = mapBase?.content ?? mapBase;
  const { checksum: _c, ...doc } = content;
  const mapId = `rc2ci-${stamp}`;
  const modes = new Set([...(doc.meta?.supportedModes ?? []), "deathmatch"]);
  const draft = await call("POST", "/maps/drafts", {
    json: { ...doc, mapId, meta: { ...doc.meta, name: `RC2 CI ${stamp}`, supportedModes: [...modes] } },
    expect: [200, 201],
  });
  const pubMap = await call("POST", `/maps/${encodeURIComponent(mapId)}/versions/${draft.version}/actions/publish`);
  out.map = { mapId, version: draft.version, state: pubMap.state };

  out.phase = "battle";
  const created = await call("POST", "/battles", {
    json: {
      mode: "deathmatch",
      rulesetId: "deathmatch-mvp",
      mapId,
      mapVersion: draft.version,
      participants: [
        { botId: a.botId, version: a.version, team: "red" },
        { botId: b.botId, version: b.version, team: "blue" },
      ],
    },
    expect: [202],
  });
  const battleId = created.id;
  out.battle = { battleId, createdAt: new Date().toISOString() };
  save();
  const final = await poll(
    "batalla",
    () => call("GET", `/battles/${battleId}`),
    (x) => x && ["finished", "failed", "cancelled", "error"].includes(x.status),
    { timeoutMs: 600_000, everyMs: 5000 },
  );
  Object.assign(out.battle, {
    status: final.status,
    result: final.result ?? null,
    participants: final.participants ?? [],
    replayAvailable: final.replayAvailable ?? false,
    finishedAt: new Date().toISOString(),
  });
  if (final.status !== "finished") throw new Error(`batalla terminó en ${final.status}`);

  out.phase = "stats";
  const stats = await call("GET", `/battles/${battleId}/stats`);
  const red = out.battle.participants.find((p) => p.team === "red");
  const blue = out.battle.participants.find((p) => p.team === "blue");
  const sR = stats.perBot?.[red?.botId] ?? {};
  const sB = stats.perBot?.[blue?.botId] ?? {};
  const tries = (s) => (s.perModule?.turret_main?.uses ?? 0) + (s.perModule?.turret_main?.rejections ?? 0);
  out.battle.stats = {
    redShots: sR.shotsFired ?? null,
    blueShots: sB.shotsFired ?? null,
    redTries: tries(sR),
    blueTries: tries(sB),
  };

  out.phase = "replay";
  const idx = await fetch(`${API}/replays/${battleId}/index`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  out.battle.replayIndexStatus = idx.status;
  const gw = await fetch(`${base.replace(/\/$/, "")}/replays/${battleId}/index`, {
    signal: AbortSignal.timeout(30_000),
  });
  out.battle.gatewayReplaysStatus = gw.status; // TD-004: el gateway NO sirve /replays*
  out.phase = "done";
}

main()
  .then(() => {
    out.ok = true;
    out.endedAt = new Date().toISOString();
    save();
    console.log(
      `flow OK: builds ${Object.values(out.bots)
        .map((b) => b.buildId)
        .join(", ")} · batalla ${out.battle?.battleId}`,
    );
  })
  .catch((e) => {
    out.ok = false;
    out.error = String(e?.message ?? e);
    out.endedAt = new Date().toISOString();
    save();
    console.error(`flow FALLÓ en la fase ${out.phase}: ${out.error}`);
    process.exit(1);
  });
