/**
 * EQ5b · Ayuda offline de Administración → Streaming. Verificado contra el código:
 *  - estados y textos: UX_TEXT de pages/StreamingPage.tsx (la MISMA fuente que la pantalla);
 *  - clases de cambio: IMPACT_TEXT (pantalla) = CHANGE_CLASSES de la API;
 *  - rangos de bitrate: recommendation() (pantalla) = bitrateRecommendation() de la API;
 *  - retardo: copia de reglas (spectator.delaySeconds), 30 s por defecto en torneos.
 * Nada de topología interna: es un repositorio público.
 */
import { IMPACT_TEXT, recommendation, UX_TEXT, type UxState } from "../../pages/StreamingPage.js";
import { helpHref } from "../tree.js";

const ORDER: UxState[] = [
  "disabled",
  "ready",
  "live",
  "recording",
  "retrying",
  "failed",
  "interrupted",
  "streamer_unreachable",
];

export function StreamingHelp() {
  const r30 = recommendation("1080p", 30);
  const r60 = recommendation("1080p", 60);
  const r720 = recommendation("720p", 30);
  return (
    <div data-testid="help-streaming">
      <p>
        <strong>Administración → Streaming</strong> (sólo administradores) emite a YouTube o a un servidor RTMPS propio,
        o graba un MP4, la vista <code>/broadcast</code> de una batalla o de un torneo. Todo se hace desde esta
        pantalla: no hace falta entrar al servidor ni tocar ficheros.
      </p>
      <h4>Paso a paso</h4>
      <ol>
        <li>En «Configuración», marca «Streaming activado», elige el modo (emitir o sólo grabar) y la plataforma.</li>
        <li>
          En «Credenciales», pega la clave de emisión de la plataforma y pulsa «Guardar clave». Se guarda cifrada y
          nunca se vuelve a mostrar: sólo verás «configurada (****ABCD)». Puedes cambiarla o eliminarla. La clave queda
          atada a la URL de ingesta: en «RTMPS personalizado» guarda primero la URL; si después la cambias, tendrás que
          volver a introducir la clave.
        </li>
        <li>
          Elige el destino: escribe el id o usa el botón «Retransmitir» del detalle de una batalla o de un torneo, que
          abre esta pantalla con el destino ya puesto (sin empezar a emitir). Pulsa «Comprobar destino».
        </li>
        <li>Opcional: «Probar configuración» comprueba la conexión segura con la plataforma sin emitir nada.</li>
        <li>Pulsa «Iniciar emisión» (o «Iniciar grabación»). Para terminar, «Detener».</li>
      </ol>
      <h4>Estados</h4>
      <dl data-testid="help-streaming-states">
        {ORDER.map((s) => (
          <div key={s}>
            <dt>
              <strong>{UX_TEXT[s].title}</strong>
            </dt>
            <dd>{UX_TEXT[s].text}</dd>
          </div>
        ))}
      </dl>
      <h4>Codificación</h4>
      <ul>
        <li>
          Resolución 1080p (por defecto) o 720p; 30 FPS por defecto. 60 FPS pide confirmación: dobla CPU y ancho de
          banda.
        </li>
        <li>
          Bitrate recomendado: 1080p30 {r30.recommended} kbit/s ({r30.min}-{r30.max}), 1080p60 {r60.recommended} kbit/s
          ({r60.min}-{r60.max}), 720p30 {r720.recommended} kbit/s ({r720.min}-{r720.max}).
        </li>
        <li>NVENC (GPU) sólo aparece disponible si el servidor lo confirma de verdad; si no, x264 (CPU).</li>
      </ul>
      <h4>Cambios con una emisión en curso</h4>
      <p>Guardar nunca reinicia la emisión por sorpresa. Según lo que cambies:</p>
      <ul data-testid="help-streaming-impact">
        <li>retención: {IMPACT_TEXT.hot};</li>
        <li>
          modo, plataforma, ingesta, codificación, branding o clave: {IMPACT_TEXT.restart} (botón «Reiniciar emisión»,
          corte de unos segundos);
        </li>
        <li>desactivar el streaming: {IMPACT_TEXT.stop} (pide confirmación).</li>
      </ul>
      <h4>Retardo</h4>
      <p>
        El retardo del directo no se configura aquí: sale de las reglas de la batalla o del torneo (en torneos, 30 s
        salvo que las reglas digan otra cosa; la final va sin retardo). La pantalla lo muestra al comprobar el destino.
        Ver <a href={helpHref("referencia", "reglas")}>Reglas</a>.
      </p>
      <h4>Grabaciones y retención</h4>
      <p>
        En modo «Sólo grabar» se guarda un MP4 por emisión. La retención borra los MP4 más antiguos que 7, 14, 30 días o
        un valor propio, o los más viejos si se supera un tamaño total. Nunca borra replays, otros ficheros ni la
        grabación en curso, y cada borrado queda en la auditoría.
      </p>
      <h4>Branding</h4>
      <p>Nombre del evento, logo (https:// o una ruta del propio sitio) y dos colores #hex, con vista previa.</p>
      <h4>Sólo se emite lo público</h4>
      <p>
        <code>/broadcast</code> es una vista anónima: sólo puede mostrar batallas cuyos bots sean públicos (y la
        instalación tiene que tener activado el directo público).
      </p>
    </div>
  );
}
