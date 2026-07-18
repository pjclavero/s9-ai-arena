import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { scanCompose } from "../src/compose-scanner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..", "..");
const fx = (name: string) => readFileSync(join(__dirname, "fixtures-compose", name), "utf8");

describe("T6.2 · escaneo de seguridad del Compose (cap. 28)", () => {
  it("marca docker.sock montado", () => {
    const v = scanCompose(fx("bad-dockersock.yml"));
    expect(v.some((x) => x.rule === "docker_sock_mount")).toBe(true);
  });

  it("marca privileged, cap ALL, host network/pid y seccomp unconfined", () => {
    const rules = scanCompose(fx("bad-privileged.yml")).map((v) => v.rule);
    expect(rules).toContain("privileged");
    expect(rules).toContain("cap_add_all");
    expect(rules).toContain("host_network");
    expect(rules).toContain("pid_host");
    expect(rules).toContain("security_opt_unconfined");
  });

  it("un Compose endurecido no da falsos positivos (docker.sock comentado no cuenta)", () => {
    expect(scanCompose(fx("good.yml"))).toEqual([]);
  });

  it("el docker-compose.demo.yml REAL del repo está limpio", () => {
    const v = scanCompose(readFileSync(join(repoRoot, "docker-compose.demo.yml"), "utf8"));
    expect(v).toEqual([]);
  });

  it("la CLI scan-compose.ts sale 0 con el compose real y 1 con uno malicioso", () => {
    // real → exit 0
    execFileSync("npx", ["tsx", join(repoRoot, "scripts", "scan-compose.ts"), join(repoRoot, "docker-compose.demo.yml")], {
      cwd: repoRoot,
      stdio: "pipe",
    });
    // malicioso → exit 1
    let failed = false;
    try {
      execFileSync(
        "npx",
        [
          "tsx",
          join(repoRoot, "scripts", "scan-compose.ts"),
          join(__dirname, "fixtures-compose", "bad-dockersock.yml"),
        ],
        { cwd: repoRoot, stdio: "pipe" },
      );
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
  });
});
