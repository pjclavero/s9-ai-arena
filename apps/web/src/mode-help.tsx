/**
 * EQ4 · ⓘ de los MODOS de juego, con la semántica actual del motor
 * (apps/arena-engine/src/sim/modes.ts). Se usa junto a los selectores de modo.
 * OJO: el título NO puede contener «modo»: el nombre accesible del botón
 * («Ayuda: …») casaría con `getByLabel('modo')` de los specs del selector.
 * Un modo desconocido (p. ej. uno nuevo de las reglas aún sin texto) no rompe:
 * sale con su nombre y sin descripción.
 */
import { InfoTip } from "./help/InfoTip.js";
import { modeName } from "./battle-result.js";

/** Cómo se gana en todos los modos (BaseMode.winner). */
export const WIN_RULE =
  "Gana quien llega antes a los puntos de victoria del ruleset; si se acaba el tiempo, quien más puntos tiene (igualados = empate). Sin reaparición, si sólo queda un bando con vehículos, gana ese bando.";

export const MODE_HELP: Record<string, string> = {
  deathmatch: "Todos contra todos: cada bot juega solo y suma un punto por cada derribo.",
  team_deathmatch:
    "Dos bandos (rojo y azul) de hasta 4 bots: cada derribo de un rival suma un punto a tu bando (derribar a un compañero, si hay fuego amigo, se lo da al rival).",
  capture_the_flag:
    "Cada bando tiene una bandera y una base: coge la bandera rival y llévala a tu base para capturarla (un punto por captura).",
  zone_control:
    "Hay zonas de captura en el mapa: cada tick puntúa el bando que tiene vehículos dentro de una zona sin ningún rival. Una zona vacía o disputada no da puntos a nadie.",
};

export function ModeHelp(props: { modes: string[]; testId?: string }) {
  return (
    <InfoTip topic="Tipos de partida" testId={props.testId ?? "mode-help"}>
      {props.modes.map((m) => (
        <span key={m} style={{ display: "block", marginTop: "0.3rem" }} data-mode={m}>
          <strong>{modeName(m)}:</strong> {MODE_HELP[m] ?? ""}
        </span>
      ))}
      <span style={{ display: "block", marginTop: "0.4rem" }}>{WIN_RULE}</span>
    </InfoTip>
  );
}
