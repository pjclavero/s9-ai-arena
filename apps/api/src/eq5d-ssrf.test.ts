/**
 * EQ5d · Regresiones propias del filtro SSRF de la ingesta con IPv6 (revisión
 * EQ6c, P3-6). Suite pura (sin BD). Sólo direcciones de documentación
 * (RFC 5737: 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24; RFC 3849:
 * 2001:db8::/32) y rangos privados genéricos.
 */
import { describe, expect, it } from "vitest";
import { ipv6Hextets, isInternalIngestHost, validIngestUrl } from "./services/streaming.js";

const accepted = (h: string) => validIngestUrl(`rtmps://${h}/live2`) !== null;

describe("EQ5d · normalización IPv6", () => {
  it("expande `::`, la IPv4 final y la notación completa a los mismos 8 grupos", () => {
    expect(ipv6Hextets("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Hextets("0:0:0:0:0:0:0:1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Hextets("::ffff:10.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 1]);
    expect(ipv6Hextets("64:ff9b::203.0.113.7")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xcb00, 0x7107]);
    expect(ipv6Hextets("2001:db8::")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
  });
});

describe("EQ5d · IPv6 que incrustan una IPv4", () => {
  it("formas obsoletas (compatible, mapeada, traducida) ⇒ rechazo SIEMPRE, también con IPv4 pública", () => {
    const always = [
      "[::10.0.0.1]",
      "[::203.0.113.7]", // compatible con IPv4 pública: igualmente obsoleta
      "[::cb00:7107]",
      "[::ffff:203.0.113.7]",
      "[::ffff:cb00:7107]",
      "[::ffff:0:10.0.0.1]",
      "[::ffff:0:203.0.113.7]",
      "[::ffff:0:a00:1]",
      "[0:0:0:0:0:ffff:0a00:0001]",
    ];
    expect(always.filter(accepted)).toEqual([]);
  });

  it("NAT64 (64:ff9b::/96) y 6to4 (2002::/16): la IPv4 extraída decide, con la MISMA lista", () => {
    const internal = [
      "[64:ff9b::10.0.0.1]",
      "[64:ff9b::a00:1]",
      "[64:ff9b::172.16.0.1]",
      "[64:ff9b::169.254.169.254]",
      "[64:ff9b::100.64.0.1]",
      "[64:ff9b::192.0.2.1]", // 192.0.x: reservada en la lista IPv4
      "[2002:a00:1::]",
      "[2002:c0a8:1::1]",
      "[2002:a9fe:a9fe::]",
      "[2002:7f00:1:1::1]",
    ];
    expect(internal.filter(accepted)).toEqual([]);
    // Controles positivos: la misma forma con una IPv4 pública (documentación) pasa.
    expect(accepted("[64:ff9b::203.0.113.7]")).toBe(true);
    expect(accepted("[64:ff9b::cb00:7107]")).toBe(true);
    expect(accepted("[2002:cb00:7107::1]")).toBe(true);
    expect(accepted("[2002:c633:6401::]")).toBe(true); // 198.51.100.1
  });

  it("NAT64 local, Teredo, site-local, descarte, ULA, link-local y multicast ⇒ rechazo", () => {
    const bad = [
      "[64:ff9b:1::203.0.113.7]",
      "[64:ff9b:0:1::1]",
      "[2001:0:4136:e378:8000:63bf:3fff:fdd2]",
      "[2001::1]",
      "[fec0::1]",
      "[fedc:1::1]",
      "[feff::1]",
      "[100::1]",
      "[fc00::1]",
      "[fdff::1]",
      "[fe80::1]",
      "[febf::1]",
      "[ff02::1]",
    ];
    expect(bad.filter(accepted)).toEqual([]);
  });

  it("control: IPv6 pública de documentación y nombres públicos siguen pasando", () => {
    expect(accepted("[2001:db8::1]")).toBe(true);
    expect(accepted("[2001:db8:85a3::8a2e:370:7334]")).toBe(true);
    expect(accepted("a.rtmps.youtube.com")).toBe(true);
    expect(accepted("203.0.113.7")).toBe(true);
    expect(isInternalIngestHost("[2001:db8::1]")).toBe(false);
  });
});
