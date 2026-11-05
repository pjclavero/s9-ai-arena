/**
 * EQ5b · §9 · Botón contextual «Retransmitir» en el detalle de una batalla o de un
 * torneo. Sólo ABRE Administración → Streaming con el destino preseleccionado:
 * no arranca nada (arrancar exige pulsar «Iniciar» allí, con la configuración a
 * la vista). Sólo lo ve quien puede usar esa pantalla (admin): la interfaz
 * oculta, la API autoriza.
 */
import type { Me } from "../api.js";
import { roleRank, userRank } from "../admin-nav.js";

export function streamingHref(kind: "battle" | "tournament", id: string): string {
  return `#/streaming?${kind}=${encodeURIComponent(id)}`;
}

export function BroadcastButton(props: { me?: Me | null; kind: "battle" | "tournament"; id: string }) {
  if (!props.me || userRank(props.me) < roleRank("admin")) return null;
  return (
    <p>
      <a
        href={streamingHref(props.kind, props.id)}
        data-testid={`broadcast-${props.kind}`}
        title="Abre Administración → Streaming con este destino seleccionado. No empieza a emitir hasta que pulses «Iniciar»."
      >
        Retransmitir
      </a>
    </p>
  );
}
