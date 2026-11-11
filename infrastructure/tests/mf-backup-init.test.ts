/**
 * OLA2-MF · el contenedor `backup` lleva un init (tini) como PID 1.
 *
 * Sin él PID 1 era `crond` (el entrypoint hace `exec crond -f`), que sólo espera
 * a SUS trabajos: los huérfanos reparentados a PID 1 —el `ssh` que restic lanza
 * para el backend sftp:, los hijos de los `docker exec` del healthcheck— quedaban
 * zombis para siempre (44 `ssh` zombis colgando de crond en producción).
 * Mismo criterio que el streamer, que ya lo tenía (Chromium y sus renderers).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const compose = parse(readFileSync(join(here, "..", "docker-compose.yml"), "utf8"), { merge: true }) as {
  services: Record<string, { init?: boolean }>;
};

describe("OLA2-MF · reaping de huérfanos en contenedores con hijos efímeros", () => {
  it.each(["backup", "streamer"])("%s: init: true (tini recoge a los huérfanos)", (svc) => {
    expect(compose.services[svc]?.init).toBe(true);
  });

  it("backup: el entrypoint sigue haciendo exec de crond (tini queda como PID 1, crond como hijo)", () => {
    const ep = readFileSync(join(here, "..", "backup", "entrypoint.sh"), "utf8");
    expect(ep).toMatch(/^exec crond -f/m);
  });
});
