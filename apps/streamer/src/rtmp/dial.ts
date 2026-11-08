/**
 * STREAMING-UX · §27 · Marcado de la ingesta: IPv4 primero, con plazo por
 * intento y TLS verificado contra el NOMBRE.
 *
 * Caso de producción: el DNS del contenedor devolvía la AAAA de la ingesta en
 * primer lugar y el host no tenía ruta IPv6. `tls.connect({host})` dejaba la
 * elección de dirección a Node, y el intento IPv6 se quedaba colgado sin caer a
 * IPv4 a tiempo.
 *
 * Aquí el relé resuelve él mismo, con `lookup(host, {all: true})`, y prueba las
 * direcciones en este orden: primero TODAS las IPv4 y después las IPv6, cada
 * una con su propio plazo (`attemptTimeoutMs`). Una dirección muerta cuesta un
 * plazo de intento, no el plazo entero de la conexión. Sobre el primer TCP que
 * conecta se monta el TLS con `servername` = host y `rejectUnauthorized`. El
 * certificado se verifica contra el nombre de la ingesta, nunca contra la IP
 * marcada, así que conectar por IP no relaja la verificación.
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import type { Duplex } from "node:stream";

export type LookupAll = (host: string) => Promise<LookupAddress[]>;
/** Abre un TCP hacia `address:port` (inyectable en tests para simular una ruta muerta). */
export type TcpConnect = (address: string, port: number, family: number) => Socket;

export interface DialTarget {
  protocol: "rtmps" | "rtmp";
  host: string;
  port: number;
}

export interface DialOptions {
  lookup?: LookupAll;
  tcpConnect?: TcpConnect;
  /** Plazo de CADA intento TCP (por dirección). Por defecto 4 s. */
  attemptTimeoutMs?: number;
  /** Sólo tests: CA propia (en producción, la del sistema o NODE_EXTRA_CA_CERTS). */
  tls?: Pick<ConnectionOptions, "ca">;
}

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 4000;

const defaultLookup: LookupAll = (host) =>
  new Promise((resolve, reject) =>
    dnsLookup(host, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs))),
  );

const defaultTcp: TcpConnect = (address, port, family) => netConnect({ host: address, port, family });

/** Orden de marcado: IPv4 antes que IPv6, y dentro de cada familia el orden del DNS. Sin duplicados. */
export function dialOrder(addrs: LookupAddress[]): LookupAddress[] {
  const seen = new Set<string>();
  const uniq = addrs.filter((a) => (seen.has(a.address) ? false : (seen.add(a.address), true)));
  return [...uniq.filter((a) => a.family === 4), ...uniq.filter((a) => a.family !== 4)];
}

export class DialError extends Error {
  constructor(
    message: string,
    readonly code: string,
    /** Resumen por dirección (sin secretos: sólo familia y motivo). */
    readonly attempts: { family: number; reason: string }[] = [],
  ) {
    super(message);
  }
}

function tryTcp(tcp: TcpConnect, a: LookupAddress, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = tcp(a.address, port, a.family);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }));
    }, timeoutMs);
    sock.once("connect", () => {
      clearTimeout(timer);
      sock.removeAllListeners("error");
      resolve(sock);
    });
    sock.once("error", (e: Error & { code?: string }) => {
      clearTimeout(timer);
      sock.destroy();
      reject(e);
    });
  });
}

/**
 * Conecta con la ingesta y devuelve el transporte (TLS en rtmps). Rechaza con
 * `DialError` si ninguna dirección responde. Los errores de TLS (certificado)
 * llegan después, por el evento 'error' del socket TLS devuelto.
 */
export async function dialIngest(t: DialTarget, o: DialOptions = {}): Promise<Duplex> {
  const attemptMs = o.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const tcp = o.tcpConnect ?? defaultTcp;
  let addrs: LookupAddress[];
  const fam = isIP(t.host);
  if (fam) addrs = [{ address: t.host, family: fam }];
  else {
    try {
      addrs = dialOrder(await (o.lookup ?? defaultLookup)(t.host));
    } catch (e) {
      throw new DialError(`no se pudo resolver la ingesta (${(e as { code?: string }).code ?? "DNS"})`, "dns");
    }
  }
  if (addrs.length === 0) throw new DialError("la ingesta no tiene direcciones", "dns");
  const attempts: { family: number; reason: string }[] = [];
  for (const a of addrs) {
    let sock: Socket;
    try {
      sock = await tryTcp(tcp, a, t.port, attemptMs);
    } catch (e) {
      attempts.push({ family: a.family, reason: String((e as { code?: string }).code ?? (e as Error).message) });
      continue;
    }
    if (t.protocol === "rtmp") return sock;
    return tlsConnect({
      socket: sock,
      host: t.host,
      // SNI y verificación del certificado contra el NOMBRE (no contra la IP marcada).
      servername: fam ? undefined : t.host,
      rejectUnauthorized: true,
      ...(o.tls?.ca ? { ca: o.tls.ca } : {}),
    });
  }
  const summary = attempts.map((x) => `IPv${x.family === 6 ? 6 : 4}: ${x.reason}`).join(", ");
  const allTimeout = attempts.every((x) => x.reason === "ETIMEDOUT");
  throw new DialError(
    allTimeout ? `la ingesta no respondió a la conexión (${summary})` : `conexión con la ingesta fallida (${summary})`,
    allTimeout ? "timeout" : "network",
    attempts,
  );
}
