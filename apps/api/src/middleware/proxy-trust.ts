/**
 * R1.8 · Confianza de proxy ACOTADA (ERR-SEC-05).
 *
 * La API vive siempre detrás del gateway del stack (Compose 6.4); en el modo
 * "detrás del proxy de VM104" hay además un segundo salto (docs/despliegue.md).
 * Sin `trust proxy`, `req.ip` es la IP del gateway para TODAS las peticiones:
 * la cuota anónima degenera en un cubo global y el bloqueo de fuerza bruta de
 * login pasa a ser `<gateway>|<email>` (bloqueo dirigido de cuentas ajenas).
 *
 * Aquí se declara el NÚMERO EXACTO de saltos de confianza, nunca `true`:
 * Express descarta cualquier entrada de X-Forwarded-For más allá de los saltos
 * declarados, así que una cabecera inyectada por el cliente externo no puede
 * alterar `req.ip` (los proxies de confianza AÑADEN la IP real a la derecha).
 *
 *   TRUST_PROXY_HOPS=0 → sin proxy delante (tests, exposición directa). Default.
 *   TRUST_PROXY_HOPS=1 → gateway del stack termina TLS (modo (a) standalone).
 *   TRUST_PROXY_HOPS=2 → Nginx de VM104 + gateway del stack (modo (b)).
 *
 * Falla cerrado: sin variable no se cree ninguna X-Forwarded-For, y un valor
 * inválido detiene el arranque en vez de degradar a una confianza incorrecta.
 */
export function resolveTrustProxyHops(raw: string | undefined = process.env.TRUST_PROXY_HOPS): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 8) {
    throw new Error(
      `TRUST_PROXY_HOPS inválido ("${raw}"): debe ser un entero 0..8 (saltos de proxy de confianza delante de la API)`,
    );
  }
  return hops;
}
