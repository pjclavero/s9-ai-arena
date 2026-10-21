/**
 * RC2 · DEV-NET — lógica de la sonda scripts/ops/network-probe.mjs.
 *
 * Lo que aquí se prueba SIN Docker: la clasificación de desenlaces, la
 * categoría que se deduce de las redes de un contenedor, el veredicto, la imagen
 * de sonda leída de DIGESTS.lock y el compose réplica derivado del render real.
 * El programa que corre dentro del contenedor de sonda (PROBE_JS) se ejecuta de
 * verdad contra un listener local para CONNECT y REFUSED.
 *
 * Lo que NO se prueba aquí (techo): ENETUNREACH real y la medida desde
 * contenedores. Eso se mide con la sonda contra un stack (informe DEV-NET y job
 * de CI contenedor → proxy).
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROBE_JS,
  categorize,
  classifyOutcome,
  expectationText,
  probeImageFromLock,
  replicaCompose,
  verdict,
} from "../../scripts/ops/network-probe.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("classifyOutcome", () => {
  it.each([
    [{ connected: true }, "CONNECT"],
    [{ timedOut: true }, "TIMEOUT"],
    [{ code: "ENETUNREACH" }, "ENETUNREACH"],
    [{ code: "EHOSTUNREACH" }, "ENETUNREACH"],
    [{ code: "ECONNREFUSED" }, "REFUSED"],
    [{ code: "ETIMEDOUT" }, "TIMEOUT"],
    [{ code: "ENOTFOUND" }, "ERROR:ENOTFOUND"],
    [{}, "ERROR:UNKNOWN"],
  ])("%j → %s", (o, cls) => expect(classifyOutcome(o)).toBe(cls));
});

describe("categorize + verdict", () => {
  const ctl = { name: "s9-bot-control", internal: true };
  const internal = { name: "x_platform", internal: true };
  const pub = { name: "x_public", internal: false };

  it("miembro de la red de control ⇒ MEMBER, aunque además tenga otras redes", () => {
    expect(categorize([internal, ctl])).toBe("MEMBER");
    expect(categorize([pub, ctl])).toBe("MEMBER");
  });
  it("sólo redes internas ⇒ INTERNAL_ONLY; alguna no interna ⇒ DEFAULT_ROUTE; sin redes ⇒ DEFAULT_ROUTE", () => {
    expect(categorize([internal])).toBe("INTERNAL_ONLY");
    expect(categorize([internal, pub])).toBe("DEFAULT_ROUTE");
    expect(categorize([])).toBe("DEFAULT_ROUTE");
  });
  it("MEMBER exige CONNECT; INTERNAL_ONLY exige ENETUNREACH (TIMEOUT o REFUSED no valen)", () => {
    expect(verdict("MEMBER", "CONNECT")).toBe(true);
    expect(verdict("MEMBER", "REFUSED")).toBe(false);
    expect(verdict("INTERNAL_ONLY", "ENETUNREACH")).toBe(true);
    expect(verdict("INTERNAL_ONLY", "CONNECT")).toBe(false);
    expect(verdict("INTERNAL_ONLY", "TIMEOUT")).toBe(false);
    expect(verdict("INTERNAL_ONLY", "REFUSED")).toBe(false);
  });
  it("DEFAULT_ROUTE sin bandera: sin veredicto (se reporta); con bandera: !CONNECT y no ERROR", () => {
    expect(verdict("DEFAULT_ROUTE", "CONNECT")).toBeNull();
    expect(expectationText("DEFAULT_ROUTE")).toBe("(medir)");
    const strict = { expectDefaultRouteBlocked: true };
    expect(verdict("DEFAULT_ROUTE", "CONNECT", strict)).toBe(false);
    expect(verdict("DEFAULT_ROUTE", "TIMEOUT", strict)).toBe(true);
    expect(verdict("DEFAULT_ROUTE", "REFUSED", strict)).toBe(true);
    expect(verdict("DEFAULT_ROUTE", "ERROR:EAI_AGAIN", strict)).toBe(false);
  });
});

describe("imagen de sonda", () => {
  it("sale del runtime node de DIGESTS.lock (3.ª columna, por digest, nunca la base)", () => {
    const lock = readFileSync(join(REPO, "runtimes", "DIGESTS.lock"), "utf8");
    const img = probeImageFromLock(lock);
    expect(img).toMatch(/^ghcr\.io\/pjclavero\/s9-ai-arena\/bot-runtime-node@sha256:[0-9a-f]{64}$/);
  });
  it("un lock sin node por digest no devuelve nada (la sonda se niega a improvisar)", () => {
    expect(probeImageFromLock("node node:22 ghcr.io/x/bot-runtime-node:latest\n")).toBeNull();
  });
});

describe("PROBE_JS ejecutado de verdad (sin Docker)", () => {
  const run = (port: number): unknown => {
    const r = spawnSync(process.execPath, ["-e", PROBE_JS, "127.0.0.1", String(port), "2000"], { encoding: "utf8" });
    return JSON.parse(r.stdout.trim());
  };

  it("CONNECT contra un listener vivo y REFUSED cuando no lo hay", async () => {
    const srv = createServer((s) => s.destroy());
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    const port = (srv.address() as { port: number }).port;
    expect(classifyOutcome(run(port) as never)).toBe("CONNECT");
    await new Promise<void>((ok) => srv.close(() => ok()));
    expect(classifyOutcome(run(port) as never)).toBe("REFUSED");
  });
});

describe("replica-compose: deriva del render real, sin tocar redes reales", () => {
  const composeCli = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
  it("conserva miembros, internal, subred y extra_hosts; renombra todas las redes con el prefijo", () => {
    if (!composeCli) throw new Error("docker compose no disponible (skipped ≠ PASS)");
    const env = { ...process.env };
    delete env.DOCKER_PROXY_URL;
    const cfg = JSON.parse(
      execFileSync(
        "docker",
        [
          "compose",
          "-f",
          join(REPO, "infrastructure", "docker-compose.yml"),
          "--env-file",
          "/dev/null",
          "--profile",
          "production",
          "--profile",
          "bots",
          "config",
          "--format",
          "json",
        ],
        { encoding: "utf8", env },
      ),
    );
    const rep = replicaCompose(cfg, { prefix: "rc2t", probeImage: "img@sha256:" + "0".repeat(64) });
    expect(Object.keys(rep.services).sort()).toEqual(Object.keys(cfg.services).sort());
    for (const [name, s] of Object.entries<any>(cfg.services)) {
      expect(rep.services[name].networks.sort(), name).toEqual(Object.keys(s.networks ?? {}).sort());
      expect(rep.services[name].extra_hosts ?? null, name).toEqual(s.extra_hosts ?? null);
      expect(rep.services[name].cap_drop).toEqual(["ALL"]);
    }
    for (const [key, n] of Object.entries<any>(cfg.networks)) {
      expect(rep.networks[key].name).toBe(`rc2t-${key}`);
      expect(rep.networks[key].internal ?? false, key).toBe(n.internal ?? false);
    }
    expect(rep.networks["bot-control"].ipam).toEqual(cfg.networks["bot-control"].ipam);
    expect(rep.networks["bot-control"].driver_opts["com.docker.network.bridge.name"]).toBe("rc2t-botctl0");
    const names = Object.values<any>(rep.networks).map((n) => n.name);
    expect(names).not.toContain("arena");
    expect(names).not.toContain("s9-bot-control");
  });
  it("rechaza un prefijo que no sea un nombre de recurso limpio", () => {
    expect(() => replicaCompose({ services: {}, networks: {} }, { prefix: "../x", probeImage: "i" })).toThrow();
  });
});
