/**
 * V1 REPLAYS · PR-5 · métricas Prometheus del almacenamiento de replays, alertas y claves `replays.*`
 * (puro, sin BD).
 *
 * M1 el registro renderiza los contadores (siempre) y los gauges de volumen (sólo medidos: sin medir no hay
 *    serie, nunca un 0 inventado).
 * M2 cada alerta de replays existe en alerts.yml y tiene su caso promtool (positivo y negativo).
 * M3 las tres claves `replays.*`: defecto en el rango, techo por entorno, consumidor del worker, en caliente,
 *    y el techo del entorno acota lo que se puede configurar.
 * M4 la sonda del volumen: libre = statfs; usado = publicados + papelera (BD, caché) + parciales AJENOS
 *    (sin contar los propios).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { WorkerMetrics } from "./worker-metrics.js";
import { makeStorageProbe } from "./replay-limits.js";
import { REPLAY_SETTING_DEFS } from "../../../packages/system-settings/replay-settings.js";
import {
  SYSTEM_SETTINGS_REGISTRY,
  envCeiling,
  validateSettingValue,
} from "../../../packages/system-settings/registry.js";
import { startTestDb, type TestDbHandle } from "../../api/src/testing/test-db.js";
import { seedDev } from "../../api/src/db/seeds/dev.js";
import { createBots, insertScheduledBattle } from "./testing/fixtures.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("PR-5 · métricas", () => {
  it("M1 contadores siempre; gauges de volumen sólo si se midieron", () => {
    const m = new WorkerMetrics();
    let text = m.render();
    for (const c of [
      "replay_aborts_battle_limit_total",
      "replay_aborts_storage_total",
      "replay_preflight_rejected_total",
    ]) {
      expect(text).toMatch(new RegExp(`^# TYPE s9_worker_${c} counter$`, "m"));
      expect(text).toMatch(new RegExp(`^s9_worker_${c} 0$`, "m"));
    }
    for (const g of [
      "volume_free_bytes",
      "volume_used_bytes",
      "quota_max_bytes",
      "min_free_bytes",
      "max_bytes_per_battle",
    ]) {
      expect(text, g).not.toMatch(new RegExp(`^s9_worker_replay_${g} \\d`, "m")); // sin medir ≠ 0
    }
    m.inc("replay_aborts_storage_total");
    m.inc("replay_aborts_battle_limit_total", 2);
    m.set("replay_volume_free_bytes", 123);
    m.set("replay_quota_max_bytes", 456);
    text = m.render();
    expect(text).toMatch(/^s9_worker_replay_aborts_storage_total 1$/m);
    expect(text).toMatch(/^s9_worker_replay_aborts_battle_limit_total 2$/m);
    expect(text).toMatch(/^s9_worker_replay_volume_free_bytes 123$/m);
    expect(text).toMatch(/^s9_worker_replay_quota_max_bytes 456$/m);
    expect(m.snapshot().replay_volume_free_bytes).toBe(123);
  });

  it("M2 cada alerta de replays está en alerts.yml y tiene caso promtool", () => {
    const alerts = parse(readFileSync(join(repo, "infrastructure/observability/prometheus/alerts.yml"), "utf8"));
    const tests = readFileSync(join(repo, "infrastructure/observability/prometheus/alerts-worker.test.yml"), "utf8");
    const rules = alerts.groups.flatMap((g: { rules: { alert: string; expr: string }[] }) => g.rules);
    const expected: Record<string, RegExp> = {
      ReplayQuotaNearFull: /s9_worker_replay_volume_used_bytes \/ s9_worker_replay_quota_max_bytes\) > 0\.8/,
      ReplayQuotaCritical: /s9_worker_replay_volume_used_bytes \/ s9_worker_replay_quota_max_bytes\) > 0\.9/,
      ReplayFreeSpaceLow: /s9_worker_replay_volume_free_bytes\) < 1\.5 \* max\(s9_worker_replay_min_free_bytes\)/,
      ReplayStorageAbort: /s9_worker_replay_aborts_storage_total/,
      ReplayPreflightRejected: /s9_worker_replay_preflight_rejected_total/,
      ReplayBattleLimitReached: /s9_worker_replay_aborts_battle_limit_total/,
    };
    for (const [name, re] of Object.entries(expected)) {
      const r = rules.find((x: { alert: string }) => x.alert === name);
      expect(r, name).toBeDefined();
      expect(r.expr, name).toMatch(re);
      expect(tests).toContain(`alertname: ${name}`);
    }
    const crit = (n: string) => rules.find((x: { alert: string }) => x.alert === n).labels.severity;
    expect(crit("ReplayStorageAbort")).toBe("critical");
    expect(crit("ReplayBattleLimitReached")).toBe("warning");
  });
});

describe("PR-5 · claves replays.* de system_settings", () => {
  it("M3 defecto dentro del rango, consumidor del worker, en caliente y con techo por entorno", () => {
    expect(REPLAY_SETTING_DEFS.map((d) => d.key).sort()).toEqual([
      "replays.limits.max_bytes_per_battle",
      "replays.quota.max_bytes",
      "replays.quota.min_free_bytes",
    ]);
    for (const d of REPLAY_SETTING_DEFS) {
      expect(SYSTEM_SETTINGS_REGISTRY.get(d.key)).toBeDefined();
      expect(d.consumer).toBe("tournament-worker");
      expect(d.apply).toBe("hot");
      expect(d.env, d.key).toMatch(/^REPLAYS_[A-Z_]+$/);
      expect(d.default as number).toBeGreaterThanOrEqual(d.min!);
      expect(d.default as number).toBeLessThanOrEqual(d.max!);
      // fuera de rango no se acepta (ni por debajo ni por encima)
      expect(validateSettingValue(d, d.min! - 1, {}).ok).toBe(false);
      expect(validateSettingValue(d, d.max! + 1, {}).ok).toBe(false);
      expect(validateSettingValue(d, d.min!, {}).ok).toBe(true);
      // el entorno es TECHO: la web no puede configurar por encima de lo que fija la variable
      const env = { [d.env!]: String(d.default) };
      expect(envCeiling(d, env)).toBe(d.default);
      expect(validateSettingValue(d, (d.default as number) + 1, env).ok).toBe(false);
      expect(validateSettingValue(d, d.default, env).ok).toBe(true);
    }
    // valores del diseño (3.1): cuota 20 GiB, reserva 5 GiB, tope por batalla 64 MiB
    const def = (k: string) => SYSTEM_SETTINGS_REGISTRY.get(k)!.default;
    expect(def("replays.quota.max_bytes")).toBe(20 * 1024 ** 3);
    expect(def("replays.quota.min_free_bytes")).toBe(5 * 1024 ** 3);
    expect(def("replays.limits.max_bytes_per_battle")).toBe(64 * 1024 ** 2);
  });
});

describe("PR-5 · sonda del volumen", () => {
  let h: TestDbHandle;
  const dirs: string[] = [];
  beforeAll(async () => {
    h = await startTestDb();
    await seedDev(h.db);
  }, 180_000);
  afterAll(async () => {
    await h.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("M4 libre = statfs; usado = publicados + papelera (BD, con caché) + parciales ajenos, sin los propios", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pr5-probe-"));
    dirs.push(dir);
    mkdirSync(join(dir, ".partial"));
    writeFileSync(join(dir, ".partial", "ajeno.s9r.part"), Buffer.alloc(1000));
    writeFileSync(join(dir, ".partial", "propio.s9r.part"), Buffer.alloc(7777));
    // un artefacto publicado de 300 B + vista 200 B, y uno en papelera de 50 B, y uno purgado (no cuenta)
    const [ba, bb] = await createBots(h.db, 2, "pr5probe");
    const mkBattle = () => insertScheduledBattle(h.db, ba, bb);
    let now = 1_000;
    const probe = makeStorageProbe({ db: h.db, dir, now: () => now, cacheMs: 30_000, freeBytesFn: async () => 4242 });
    expect(await probe.freeBytes()).toBe(4242);
    expect(await probe.usedBytes([])).toBe(1000 + 7777); // sin artefactos todavía
    // se insertan artefactos: la suma está en CACHÉ hasta que pasan 30 s
    const art = async (state: string, recipe: number, view: number | null) => {
      const id = await mkBattle();
      await h.db("replay_artifacts").insert({
        battle_id: id,
        state,
        class: "practice",
        attempt: 1,
        owner: "o",
        recipe_path: `/x/${id}.s9r`,
        recipe_sha256: "a".repeat(64),
        recipe_bytes: recipe,
        ...(view ? { view_path: `/x/${id}.s9v`, view_sha256: "b".repeat(64), view_bytes: view } : {}),
        chain_hash: "c",
        ticks: 1,
      });
    };
    await art("published", 300, 200);
    await art("trashed", 50, null);
    await art("purged", 99999, null);
    expect(await probe.usedBytes([join(dir, ".partial", "propio.s9r.part")])).toBe(1000 + 7777 - 7777); // caché: aún sin los 550
    now += 31_000;
    expect(await probe.usedBytes([join(dir, ".partial", "propio.s9r.part")])).toBe(1000 + 550); // publicados + papelera, no purgados
    expect(await probe.usedBytes([])).toBe(1000 + 7777 + 550);
  }, 120_000);
});
