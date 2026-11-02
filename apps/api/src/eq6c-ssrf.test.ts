/**
 * EQ6c · Re-revisión de #227 (ronda 2) · filtro SSRF de la ingesta personalizada
 * (validIngestUrl / isInternalIngestHost). Suite pura (sin BD).
 * `CIERRE` en verde sobre a41a903; `DEFECTO` en rojo a propósito.
 */
import { describe, expect, it } from "vitest";
import { validIngestUrl } from "./services/streaming.js";

const rejects = (h: string) => validIngestUrl(`rtmps://${h}/live2`) === null;

describe("EQ6c · SSRF de la ingesta", () => {
  it("CIERRE P3 · representaciones alternativas de loopback/privadas/metadatos y nombres internos ⇒ rechazo", () => {
    const internal = [
      "0x7f.1", "127.1", "2130706433", "0177.0.0.1", "0x7f000001", "127.000.000.001", "0", "0.0.0.0",
      "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[0:0:0:0:0:0:0:1]", "[::]", "[::0:1]", "[::ffff:169.254.169.254]",
      "[fe80::1]", "[fd00::1]", "localhost", "localhost.", "LOCALHOST", "LocalHost.", "foo.localhost",
      "postgres", "postgres.", "Postgres", "api.", "web.", "s9-postgres", "host.docker.internal",
      "metadata.google.internal", "169.254.169.254", "10.0.0.1", "172.16.0.1", "192.168.0.10", "100.64.0.1",
      "%31%32%37.0.0.1", "localhost%2e",
    ];
    expect(internal.filter((h) => !rejects(h))).toEqual([]);
    // Control positivo: un host público sí pasa.
    expect(rejects("a.rtmps.youtube.com")).toBe(false);
    expect(rejects("1.1.1.1")).toBe(false);
  });

  it("DEFECTO P3 · IPv6 que incrustan una IPv4 interna (compatible ::a.b.c.d, traducida ::ffff:0:a.b.c.d, NAT64 64:ff9b::/96, 6to4 2002::/16) y site-local fec0::/10 se aceptan", () => {
    // En este host son inalcanzables (ENETUNREACH), pero en una red con NAT64/6to4 llegarían a 127.0.0.1.
    const embedded = ["[::127.0.0.1]", "[::ffff:0:127.0.0.1]", "[64:ff9b::127.0.0.1]", "[2002:7f00:1::]", "[fec0::1]"];
    expect(embedded.filter((h) => !rejects(h))).toEqual([]);
  });
});
