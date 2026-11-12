#!/usr/bin/env python3
"""OLA2-MF · mutantes del ciclo de vida de batalla.

Cada mutante aplica UNA sustitución exacta a un fichero de producción, ejecuta el
test que debe cazarlo y exige rc != 0 (rojo). Después restaura el fichero con
`git checkout --` y comprueba que el árbol vuelve a estar limpio. En serie,
nunca dos a la vez. Uso (desde la raíz del repo, en la máquina de pruebas):

    python3 -I tests/mutants/mf-lifecycle/run.py [--only M1,M2]
"""
import subprocess, sys

MUTANTS = [
    ("M1-orden-fases", "apps/tournament-worker/src/battle-resources.ts",
     "    for (const phase of PHASES) {\n      const bucket = this.entries.get(battleId);",
     "    for (const phase of [...PHASES].reverse()) {\n      const bucket = this.entries.get(battleId);",
     "apps/tournament-worker/src/battle-resources.test.ts"),
    ("M2-idempotencia", "apps/tournament-worker/src/battle-resources.ts",
     "      await e.release();\n      const b = this.entries.get(e.battleId);\n      b?.delete(e.id);",
     "      await e.release();\n      e.state = \"live\";\n      const b = this.entries.get(e.battleId);",
     "apps/tournament-worker/src/battle-resources.test.ts"),
    ("M3-aislamiento", "apps/tournament-worker/src/battle-resources.ts",
     "    const inScope = (e: Entry) => scope === null || e.scope === scope;",
     "    const inScope = (e: Entry) => scope === null || e.scope === scope;\n    for (const [k, v] of this.entries) if (k !== battleId) for (const e of v.values()) await e.release();",
     "apps/tournament-worker/src/battle-resources.test.ts"),
    ("M4-sigue-tras-fallo", "apps/tournament-worker/src/battle-resources.ts",
     "      steps.push(...(await Promise.all(now.map((e) => this.releaseEntry(e)))));",
     "      steps.push(...(await Promise.all(now.map((e) => this.releaseEntry(e)))));\n      if (steps.some((s) => s.outcome === \"failed\")) break;",
     "apps/tournament-worker/src/battle-resources.test.ts"),
    ("M5-drenaje", "apps/tournament-worker/src/battle-resources.ts",
     "if (e.drainMs && e.drainMs > 0 && reason === \"FINISHED\" && !opts.flushDrains) {",
     "if (e.drainMs && e.drainMs > 0 && !opts.flushDrains) {",
     "apps/tournament-worker/src/battle-resources.test.ts"),
    ("M6-sin-KILL", "apps/tournament-worker/src/battle-resources.ts",
     "  if (!alive) return \"terminated\";\n  await h.stop({ timeoutSeconds: 0 });",
     "  if (!alive || true) return \"terminated\";\n  await h.stop({ timeoutSeconds: 0 });",
     "apps/tournament-worker/src/mf-battle-teardown.test.ts"),
    ("M7-sin-borrado-contenedor", "apps/tournament-worker/src/container-agents.ts",
     "            if (h.remove) {",
     "            if (h.remove && false) {",
     "apps/tournament-worker/src/mf-battle-teardown.test.ts"),
    ("M8-sin-teardown-agentes", "apps/tournament-worker/src/container-agents.ts",
     "        await res.cleanupBattleResources(battleId, \"FAILED\", { scope: SCOPE });\n      }",
     "        void 0;\n      }",
     "apps/tournament-worker/src/mf-battle-teardown.test.ts"),
    ("M9-runner-sin-finally", "apps/tournament-worker/src/battle-runner.ts",
     "      const cleanup = await res.cleanupBattleResources(battleId, reason);",
     "      const cleanup = await res.cleanupBattleResources(battleId, endOk ? reason : \"FINISHED\", { scope: \"nadie\" });",
     "apps/tournament-worker/src/mf-runner-reaper.test.ts"),
    ("M10-clasificacion", "apps/tournament-worker/src/battle-resources.ts",
     "  if (err?.name === \"SportingFailure\") return err.code === \"bot_timeout\" ? \"TIMEOUT\" : \"BOT_CRASH\";",
     "  if (err?.name === \"SportingFailure\") return \"BOT_CRASH\";",
     "apps/tournament-worker/src/mf-runner-reaper.test.ts"),
    ("M11-reaper-intento-vivo", "apps/tournament-worker/src/battle-reaper.ts",
     "      !sameOwner(row.claimed_by, c.labels[LABEL_BATTLE_OWNER])",
     "      true",
     "apps/tournament-worker/src/mf-runner-reaper.test.ts"),
    ("M12-reaper-terminales", "apps/tournament-worker/src/battle-reaper.ts",
     "    else if (TERMINAL.has(row.status)) why = `batalla ${row.status}`;",
     "    else if (false) why = `batalla ${row.status}`;",
     "apps/tournament-worker/src/mf-runner-reaper.test.ts"),
    ("M13-motor-tumba-proceso", "apps/arena-engine/src/protocol-server.ts",
     "      try {\n        this.battle.step();\n      } catch (err) {",
     "      try {\n        this.battle.step();\n      } catch (err) {\n        throw err;",
     "apps/tournament-worker/src/mf-battle-teardown.test.ts"),
    ("M14-proxy-start-fallido", "apps/bot-manager/src/docker-proxy.ts",
     "      await this.removeById(id).catch(() => undefined);",
     "      void 0;",
     "apps/bot-manager/tests/docker-proxy-lifecycle.test.ts"),
    ("M15-proxy-lista-ajenos", "apps/bot-manager/src/docker-proxy.ts",
     "    if (!Object.entries(want).every(([k, v]) => labels[k] === v)) continue;",
     "    void want;",
     "apps/bot-manager/tests/docker-proxy-lifecycle.test.ts"),
    ("M16-proxy-lista-sin-filtro", "apps/bot-manager/src/docker-proxy.ts",
     "  if (raw === null) return { ok: false, reason: \"listado sin `filters`: nunca se lista todo el host\" };",
     "  if (raw === null) return { ok: true, labels: [] };",
     "apps/bot-manager/tests/docker-proxy-lifecycle.test.ts"),
    ("M17-xvfb-no-se-para", "apps/streamer/src/supervisor.ts",
     "    this.stopProcesses();\n    this.opts.display?.release();\n    const was = this.state_;",
     "    this.stopProcesses();\n    const was = this.state_;",
     "apps/streamer/src/xvfb-on-demand.test.ts"),
    ("M18-xvfb-vivo-tras-failed", "apps/streamer/src/supervisor.ts",
     "      this.opts.display?.release();\n      this.opts.logger(\"error\", \"emisión abandonada",
     "      this.opts.logger(\"error\", \"emisión abandonada",
     "apps/streamer/src/xvfb-on-demand.test.ts"),
    ("M19-backup-sin-init", "infrastructure/docker-compose.yml",
     "    # zombis colgando de crond en producción). Mismo criterio que el streamer.\n    init: true",
     "    # zombis colgando de crond en producción). Mismo criterio que el streamer.",
     "infrastructure/tests/mf-backup-init.test.ts"),
    # Contrato BATTLE_FINISHED != STREAM_SESSION_FINISHED: el reaper sólo puede ver contenedores de batalla.
    ("M20-reaper-lista-sin-rol", "apps/tournament-worker/src/battle-reaper.ts",
     "containers = await deps.runner.list({ [LABEL_ROLE]: ROLE_BATTLE_BOT });",
     "containers = await deps.runner.list({});",
     "apps/tournament-worker/src/mf-stream-session-survives.test.ts"),
    ("M22-remove-409-en-curso-falla", "apps/bot-manager/src/docker-proxy.ts",
     "    if (res.status === 409 && /removal of container",
     "    if (false && /removal of container",
     "apps/bot-manager/tests/docker-proxy-lifecycle.test.ts"),
    # --- Correcciones de la revisión (REVIEW-MF) ---
    # Fuga de memoria por batalla: el test de resistencia con Docker real DEBE ponerse rojo (opt-in, banco).
    ("M23-fuga-buffer-por-batalla", "apps/tournament-worker/src/container-agents.ts",
     "        if (guard) clearTimeout(guard);\n        if (cpuSampler) clearInterval(cpuSampler);\n        if (onAbort) signal?.removeEventListener",
     "        ((globalThis as any).__mfLeak ??= []).push(Buffer.alloc(3 * 1024 * 1024, 1));\n        if (guard) clearTimeout(guard);\n        if (cpuSampler) clearInterval(cpuSampler);\n        if (onAbort) signal?.removeEventListener",
     "apps/tournament-worker/src/mf-resistance-docker.test.ts -t 'batallas normales'", "S9_RUN_DOCKER_SANDBOX_E2E=1 DOCKER_SOCKET=/var/run/docker.sock S9_MF_BATTLES=16 S9_MF_ALLOW_SHORT=1 NODE_OPTIONS=--expose-gc"),
    ("M24-fuga-objetos-por-batalla", "apps/tournament-worker/src/container-agents.ts",
     "        if (guard) clearTimeout(guard);\n        if (cpuSampler) clearInterval(cpuSampler);\n        if (onAbort) signal?.removeEventListener",
     "        ((globalThis as any).__mfLeak2 ??= []).push({ engine, vehicles, junk: Array.from({ length: 60000 }, (_, i) => ({ i, s: String(i) })) });\n        if (guard) clearTimeout(guard);\n        if (cpuSampler) clearInterval(cpuSampler);\n        if (onAbort) signal?.removeEventListener",
     "apps/tournament-worker/src/mf-resistance-docker.test.ts -t 'batallas normales'", "S9_RUN_DOCKER_SANDBOX_E2E=1 DOCKER_SOCKET=/var/run/docker.sock S9_MF_BATTLES=16 S9_MF_ALLOW_SHORT=1 NODE_OPTIONS=--expose-gc"),
    ("M25-xvfb-sin-esperar-a-dying", "apps/streamer/src/xvfb.ts",
     "    if (this.dying === 0) return;",
     "    return;",
     "apps/streamer/src/xvfb-on-demand.test.ts"),
    ("M26-409-sondeo-sin-battleId", "apps/bot-manager/src/docker-proxy.ts",
     "...(battleId ? { \"arena.battle-id\": battleId } : {})",
     "",
     "apps/bot-manager/tests/docker-proxy-lifecycle.test.ts"),
    ("M27-worker-sin-stop-grace", "infrastructure/docker-compose.yml",
     "    stop_grace_period: 45s\n",
     "",
     "infrastructure/tests/mf-backup-init.test.ts"),
    ("M28-cancelled-mal-clasificado", "apps/tournament-worker/src/battle-resources.ts",
     "    if (err.code === \"battle_busy\") return \"CANCELLED\";",
     "    if (err.code === \"battle_busy\") return \"FAILED\";",
     "apps/tournament-worker/src/mf-runner-reaper.test.ts"),
    ("M29-sin-cota-absoluta-rss", "apps/tournament-worker/src/mf-growth.ts",
     "  if (!(rssAbs < L.rssAbsMax))",
     "  if (false)",
     "apps/tournament-worker/src/mf-growth.test.ts"),
]

def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, **kw)

only = None
if "--only" in sys.argv:
    only = set(sys.argv[sys.argv.index("--only") + 1].split(","))

if sh("git diff --quiet").returncode != 0:
    sys.exit("árbol sucio: commitea antes de calibrar")

results = []
for name, path, old, new, test, *envp in MUTANTS:
    if only and name.split("-")[0] not in only:
        continue
    src = open(path, encoding="utf8").read()
    if src.count(old) != 1:
        results.append((name, "NO_APLICA"))
        continue
    open(path, "w", encoding="utf8").write(src.replace(old, new))
    env = envp[0] + " " if envp else ""
    rc = sh(f"{env}npx vitest run {test} > /tmp/mf-mut-{name}.log 2>&1").returncode
    sh(f"git checkout -- {path}")
    results.append((name, "ROJO(cazado)" if rc != 0 else "VERDE(NO cazado)"))

if sh("git diff --quiet").returncode != 0:
    sys.exit("el árbol no quedó limpio tras los mutantes")
for n, r in results:
    print(f"{n}\t{r}")
sys.exit(0 if all(r == "ROJO(cazado)" for _, r in results) else 1)
