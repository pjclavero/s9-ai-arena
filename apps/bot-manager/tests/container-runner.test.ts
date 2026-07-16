import { describe, it, expect } from "vitest";
import {
  DockerContainerRunner,
  DEFAULT_LIMITS,
  complianceViolations,
  assertCompliant,
  type SandboxSpec,
  type SecurityPosture,
} from "../src/container-runner.js";

function spec(): SandboxSpec {
  return {
    imageDigest: "arena/bot-runtime-python@sha256:abc",
    botId: "bot_x",
    version: 1,
    battleId: "btl_1",
    network: "arena",
    engineEndpoint: "ws://arena-engine:8081/bot",
    env: { BOT_ID: "bot_x", BATTLE_TOKEN: "0123456789abcdef" },
    limits: DEFAULT_LIMITS,
    seccompProfilePath: "/security/seccomp-bot.json",
  };
}

describe("T6.2 · flags de la tabla 18.2 (buildRunArgs)", () => {
  it("incluye todos los controles obligatorios", () => {
    const args = DockerContainerRunner.buildRunArgs(spec(), "c1").join(" ");
    expect(args).toContain("--user 10001:10001");
    expect(args).toContain("--security-opt no-new-privileges");
    expect(args).toContain("--cap-drop ALL");
    expect(args).toContain("--security-opt seccomp=/security/seccomp-bot.json");
    expect(args).toContain("--read-only");
    expect(args).toContain("--tmpfs /tmp:rw,noexec,nosuid,nodev,size=");
    expect(args).toContain("--network arena");
    expect(args).toContain("--dns 0.0.0.0");
    expect(args).toContain("--cpus 0.5");
    expect(args).toContain(`--memory ${DEFAULT_LIMITS.memoryBytes}`);
    expect(args).toContain(`--pids-limit ${DEFAULT_LIMITS.pids}`);
  });

  it("NUNCA monta docker.sock ni volúmenes de host", () => {
    const args = DockerContainerRunner.buildRunArgs(spec(), "c1");
    expect(args).not.toContain("-v");
    expect(args.join(" ")).not.toContain("docker.sock");
    expect(args.join(" ")).not.toContain("--privileged");
  });
});

function compliantInspect() {
  return [
    {
      Config: { User: "10001:10001" },
      HostConfig: {
        CapDrop: ["ALL"],
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges", "seccomp=/security/seccomp-bot.json"],
        Tmpfs: { "/tmp": "rw,size=32m" },
        Dns: ["0.0.0.0"],
        Privileged: false,
        NanoCpus: 500000000,
        Memory: 268435456,
        PidsLimit: 64,
      },
      Mounts: [],
      NetworkSettings: { Networks: { arena: {} } },
    },
  ];
}

describe("T6.2 · inspección de la config real (analyzeInspect)", () => {
  it("una config conforme no tiene violaciones", () => {
    const posture = DockerContainerRunner.analyzeInspect(compliantInspect());
    expect(complianceViolations(posture)).toEqual([]);
    expect(() => assertCompliant(posture)).not.toThrow();
  });

  it("detecta docker.sock montado, root, privileged y seccomp unconfined", () => {
    const bad = compliantInspect();
    bad[0].Config.User = "root";
    bad[0].HostConfig.Privileged = true;
    bad[0].HostConfig.SecurityOpt = ["seccomp=unconfined"];
    bad[0].HostConfig.CapDrop = [];
    bad[0].HostConfig.ReadonlyRootfs = false;
    bad[0].Mounts = [{ Type: "bind", Source: "/var/run/docker.sock" } as any];
    const posture: SecurityPosture = DockerContainerRunner.analyzeInspect(bad);
    const v = complianceViolations(posture);
    expect(v.join(" | ")).toMatch(/docker/i);
    expect(v.join(" | ")).toMatch(/root/i);
    expect(v.join(" | ")).toMatch(/privilegiado/i);
    expect(v.join(" | ")).toMatch(/seccomp/i);
    expect(() => assertCompliant(posture)).toThrow();
  });

  it("detecta red externa y DNS a Internet", () => {
    const bad = compliantInspect();
    bad[0].NetworkSettings.Networks = { arena: {}, bridge: {} } as any;
    bad[0].HostConfig.Dns = ["8.8.8.8"];
    const v = complianceViolations(DockerContainerRunner.analyzeInspect(bad));
    expect(v.join(" ")).toMatch(/red no permitida/);
    expect(v.join(" ")).toMatch(/DNS externo/);
  });
});
