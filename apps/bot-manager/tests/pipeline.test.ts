import { describe, it, expect } from "vitest";
import { BuildPipeline, type PipelineDeps } from "../src/pipeline.js";
import { InMemoryBuildStore } from "../src/store.js";
import { generateServiceKeypair, verifyArtifact } from "../src/signing.js";
import { packArtifact } from "../src/artifact.js";
import { withConfig } from "../src/config.js";
import type { AuditSink, SecurityFindingInput, AuditEventInput } from "../src/audit-sink.js";
import {
  submission,
  pyGoodFiles,
  jsGoodFiles,
  pyBadDepFiles,
  pySecretFiles,
  goodCandidate,
  brokenProtocolCandidate,
  slowCandidate,
  referenceAgent,
} from "./fixtures.js";

class CollectingSink implements AuditSink {
  events: AuditEventInput[] = [];
  findings: SecurityFindingInput[] = [];
  record(e: AuditEventInput) {
    this.events.push(e);
  }
  finding(f: SecurityFindingInput) {
    this.findings.push(f);
  }
}

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    store: new InMemoryBuildStore(),
    config: withConfig(),
    signer: generateServiceKeypair(),
    audit: new CollectingSink(),
    agentResolver: () => goodCandidate,
    referenceAgent,
    ...overrides,
  };
}

describe("T6.1 · pipeline de build y publicación", () => {
  it("un bot Python correcto recorre todas las etapas y queda validated (17.1, issue #13)", async () => {
    const d = deps();
    const pipe = new BuildPipeline(d);
    const build = await pipe.run(submission(pyGoodFiles()));
    expect(build.status).toBe("passed");
    expect(build.botVersionState).toBe("validated"); // 17.1: publicar es acción explícita del dueño (issue #13)
    expect(build.stages.every((s) => s.status === "passed")).toBe(true);
    expect(build.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    expect(build.signature).toBeTruthy();
  });

  it("el artefacto publicado se verifica antes de ejecutar; manipularlo lo rechaza", async () => {
    const signer = generateServiceKeypair();
    const files = pyGoodFiles();
    const pipe = new BuildPipeline(deps({ signer }));
    const build = await pipe.run(submission(files));
    const artifact = packArtifact(files);
    // verificación previa a ejecución: ok
    expect(verifyArtifact({ artifactBytes: artifact.bytes, signedHash: build.artifactHash!, signature: build.signature!, publicKey: signer.publicKey }).ok).toBe(true);
    // artefacto manipulado: rechazado
    const tampered = Buffer.concat([artifact.bytes, Buffer.from("x")]);
    expect(verifyArtifact({ artifactBytes: tampered, signedHash: build.artifactHash!, signature: build.signature!, publicKey: signer.publicKey }).ok).toBe(false);
  });

  it("build reproducible: el mismo commit Python produce el mismo hash", async () => {
    const h1 = (await new BuildPipeline(deps()).run(submission(pyGoodFiles()))).artifactHash;
    const h2 = (await new BuildPipeline(deps()).run(submission(pyGoodFiles()))).artifactHash;
    expect(h1).toBe(h2);
  });

  it("build reproducible: el mismo commit JS produce el mismo hash", async () => {
    const s = (f: any) => submission(f, { runtime: "node" as const });
    const h1 = (await new BuildPipeline(deps()).run(s(jsGoodFiles()))).artifactHash;
    const h2 = (await new BuildPipeline(deps()).run(s(jsGoodFiles()))).artifactHash;
    expect(h1).toBe(h2);
  });

  it("una dependencia fuera de la allowlist deja el bot Rechazado, señalando el paquete", async () => {
    const sink = new CollectingSink();
    const build = await new BuildPipeline(deps({ audit: sink })).run(submission(pyBadDepFiles()));
    expect(build.status).toBe("failed");
    expect(build.botVersionState).toBe("rejected");
    expect(build.rejectionReason).toMatch(/requests/);
    const depStage = build.stages.find((s) => s.name === "dependencies")!;
    expect(depStage.status).toBe("failed");
    expect(sink.findings.some((f) => f.category === "disallowed_dependency")).toBe(true);
  });

  // H1 (issue #5): un bot hostil de SOLO-stdlib (socket/subprocess, sin deps de
  // terceros) antes llegaba al final con un simple hallazgo; ahora la política por
  // defecto lo BLOQUEA en static_analysis, manteniendo el hallazgo de auditoría.
  it("un bot hostil de solo-stdlib (socket/subprocess) queda RECHAZADO en static_analysis con hallazgo (H1, issue #5)", async () => {
    const sink = new CollectingSink();
    const files = pyGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.py")!;
    bot.content = "import socket\nimport subprocess\n" + bot.content;
    const build = await new BuildPipeline(deps({ audit: sink })).run(submission(files));
    expect(build.status).toBe("failed");
    expect(build.botVersionState).toBe("rejected");
    const sa = build.stages.find((s) => s.name === "static_analysis")!;
    expect(sa.status).toBe("failed");
    expect(sa.message).toMatch(/builtin peligroso bloqueado/);
    expect(sa.message).toMatch(/socket/);
    // El hallazgo de auditoría se mantiene aunque ahora también bloquee.
    expect(sink.findings.some((f) => f.category === "dangerous_import")).toBe(true);
  });

  it("con la política 'audit', el mismo bot pasa static_analysis dejando solo el hallazgo (configurable)", async () => {
    const sink = new CollectingSink();
    const files = pyGoodFiles();
    const bot = files.find((f) => f.path === "src/bot.py")!;
    bot.content = "import socket\n" + bot.content;
    const cfg = withConfig();
    const build = await new BuildPipeline(
      deps({ audit: sink, config: { ...cfg, dangerousBuiltins: { ...cfg.dangerousBuiltins, mode: "audit" } } }),
    ).run(submission(files));
    const sa = build.stages.find((s) => s.name === "static_analysis")!;
    expect(sa.status).toBe("passed");
    expect(sink.findings.some((f) => f.category === "dangerous_import")).toBe(true);
  });

  it("la partida de humo/prueba de protocolo detecta un bot que compila pero incumple protocolo", async () => {
    const build = await new BuildPipeline(deps({ agentResolver: () => brokenProtocolCandidate })).run(submission(pyGoodFiles()));
    expect(build.botVersionState).toBe("rejected");
    const proto = build.stages.find((s) => s.name === "protocol_test")!;
    expect(proto.status).toBe("failed");
    expect(proto.message).toMatch(/command\.schema|COMMAND/);
  });

  it("un secreto (clave AWS de ejemplo) bloquea la publicación con hallazgo registrado", async () => {
    const sink = new CollectingSink();
    const build = await new BuildPipeline(deps({ audit: sink })).run(submission(pySecretFiles()));
    expect(build.botVersionState).toBe("rejected");
    const scan = build.stages.find((s) => s.name === "secret_scan")!;
    expect(scan.status).toBe("failed");
    const publish = build.stages.find((s) => s.name === "publish")!;
    expect(publish.status).toBe("pending"); // nunca se alcanzó
    expect(sink.findings.some((f) => f.category === "secret_leak" && f.severity === "critical")).toBe(true);
  });

  it("un bot que agota su cuota de CPU por decisión se rechaza en resource_limits", async () => {
    const cfg = withConfig({ smokeBattleTicks: 30 });
    const sink = new CollectingSink();
    const build = await new BuildPipeline(deps({ config: cfg, audit: sink, agentResolver: () => slowCandidate })).run(submission(pyGoodFiles()));
    const rl = build.stages.find((s) => s.name === "resource_limits")!;
    expect(rl.status).toBe("failed");
    expect(build.botVersionState).toBe("rejected");
    expect(sink.findings.some((f) => f.category === "resource_abuse")).toBe(true);
  });

  it("sin agentResolver, las etapas de ejecución quedan 'skipped' (honesto) y el resto valida", async () => {
    const build = await new BuildPipeline(deps({ agentResolver: undefined, referenceAgent: undefined })).run(submission(pyGoodFiles()));
    expect(build.botVersionState).toBe("validated"); // 17.1: publicar es acción explícita del dueño (issue #13)
    for (const name of ["protocol_test", "smoke_battle", "resource_limits"]) {
      expect(build.stages.find((s) => s.name === name)!.status).toBe("skipped");
    }
  });

  it("el pipeline completo de un bot Python sencillo termina en < 3 minutos (medido)", async () => {
    const t0 = performance.now();
    const build = await new BuildPipeline(deps()).run(submission(pyGoodFiles()));
    const ms = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[T6.1] pipeline completo (con partida de humo real): ${(ms / 1000).toFixed(1)} s`);
    expect(build.botVersionState).toBe("validated"); // 17.1: publicar es acción explícita del dueño (issue #13)
    expect(ms).toBeLessThan(180000);
  });
});
