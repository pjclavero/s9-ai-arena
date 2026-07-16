/**
 * E6 · bot-manager — autorización de lanzamiento de contenedores (T6.2/T6.4).
 *
 * DoD T6.2: "El bot-manager es el único servicio con permiso para crear estos
 * contenedores, a través de una API interna restringida; ni la web ni la API pública
 * pueden hacerlo."
 * DoD T6.4: "Un bot suspendido no puede lanzarse aunque esté inscrito en un torneo."
 *
 * LaunchAuthority es la puerta única: recibe el principal que pide lanzar y el bot, y solo
 * deja pasar si (a) el principal es el servicio interno bot-manager y (b) el bot no está
 * suspendido. La verificación de firma del artefacto (signing.ts) es un tercer candado que
 * el orquestador aplica antes de ejecutar.
 */

export type PrincipalRole = "bot-manager-internal" | "web" | "public-api" | "moderator" | "admin";

export interface Principal {
  id: string;
  role: PrincipalRole;
}

/** Consulta de estado de suspensión (la implementa T6.4). */
export interface SuspensionCheck {
  isSuspended(botId: string, version?: number): boolean;
}

export class LaunchDenied extends Error {}

export class LaunchAuthority {
  constructor(private suspension?: SuspensionCheck) {}

  /** Autoriza (o lanza LaunchDenied) el lanzamiento de un contenedor de bot. */
  authorize(principal: Principal, botId: string, version?: number): void {
    if (principal.role !== "bot-manager-internal") {
      throw new LaunchDenied(
        `solo el servicio interno bot-manager puede crear contenedores de bot; principal '${principal.id}' con rol '${principal.role}' rechazado`,
      );
    }
    if (this.suspension?.isSuspended(botId, version)) {
      throw new LaunchDenied(`bot ${botId}${version ? ` v${version}` : ""} está SUSPENDIDO: no se lanza`);
    }
  }

  canLaunch(principal: Principal, botId: string, version?: number): boolean {
    try {
      this.authorize(principal, botId, version);
      return true;
    } catch {
      return false;
    }
  }
}
