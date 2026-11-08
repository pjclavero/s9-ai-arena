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
  "starting",
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
      <p>
        La pantalla tiene un menú con cuatro apartados: <strong>Streaming</strong> (lo de todos los días),{" "}
        <strong>Configuración avanzada</strong>, <strong>Grabaciones</strong> y <strong>Auditoría</strong>. En el móvil
        son pestañas en la parte de arriba.
      </p>
      <h4>Emitir una batalla (lo normal)</h4>
      <ol data-testid="help-streaming-simple">
        <li>
          En «Streaming», elige <strong>Tipo</strong> (Batalla o Torneo) y, en la lista, la batalla por su nombre, por
          ejemplo «Team A vs Team B · Finalizada · hace 12 min». Las que están en curso salen primero. No hace falta
          ningún identificador.
        </li>
        <li>
          Debajo verás si se puede <strong>retransmitir</strong> y, si no, por qué, en una frase. El código técnico está
          en «Ver detalles técnicos».
        </li>
        <li>
          Elige el <strong>Canal</strong> (YouTube, RTMPS propio o «Sólo grabar») y la <strong>Calidad</strong> (1080p o
          720p, a 30 o 60 FPS). El bitrate se ajusta solo.
        </li>
        <li>
          Pulsa <strong>INICIAR EMISIÓN</strong>. Mientras conecta verás «Conectando con YouTube…»: todavía no está en
          directo. Cuando YouTube acepta, «● EN DIRECTO», con la duración, los FPS, el bitrate, los frames descartados y
          qué servidor se usa (Principal o Respaldo). <strong>DETENER</strong> siempre está arriba.
        </li>
      </ol>
      <p>
        El botón «Retransmitir» del detalle de una batalla o de un torneo abre esta pantalla con ella ya elegida, sin
        empezar a emitir.
      </p>
      <h4>Primera vez: configuración avanzada</h4>
      <ol>
        <li>Marca «Streaming activado» y elige el modo (emitir o sólo grabar) y la plataforma.</li>
        <li>
          <strong>Servidores de YouTube</strong>: vienen puestos el principal (
          <code>rtmps://a.rtmps.youtube.com/live2</code>) y el de respaldo (
          <code>rtmps://b.rtmps.youtube.com/live2?backup=1</code>). Puedes cambiarlos y se guardan tal cual. En el de
          respaldo de YouTube sólo se admite «?backup=1»; cualquier otra cosa detrás de «?» se rechaza.
        </li>
        <li>
          <strong>Clave de emisión</strong>: pégala y pulsa «Guardar clave». Se guarda cifrada y no se vuelve a ver:
          sólo «Configurada · ****ABCD», con «Reemplazar clave» y «Eliminar clave». Queda atada a los servidores
          principal y de respaldo. Si cambias alguno, vuelve a introducirla.
        </li>
        <li>
          «Probar ingesta» comprueba los dos servidores por separado sin emitir nada: «Principal: OK / Respaldo: OK» o
          el problema de cada uno.
        </li>
      </ol>
      <h4>Si el servidor principal falla</h4>
      <p>
        Si el principal no responde tres veces seguidas por problemas de conexión, la emisión pasa al de respaldo y se
        queda en él hasta que la detengas («Principal no disponible · Usando servidor de respaldo»). La siguiente
        emisión vuelve a empezar por el principal. Si el problema es la clave, no se cambia de servidor, porque fallaría
        igual.
      </p>
      <h4>Batallas terminadas</h4>
      <p>
        Al emitir una batalla terminada se muestra su pantalla de resultado; todavía no se puede emitir su repetición
        completa.
      </p>
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
      <h4>Qué se puede emitir</h4>
      <p>
        <code>/broadcast</code> es una vista anónima (y la instalación tiene que tener activado el directo público).
        Puede mostrar las batallas cuyos bots son todos públicos y todas las batallas de un torneo creado con
        «Retransmisión pública», también las de bots privados o de equipo. De esos bots sólo salen sus datos de
        competición (nombre, versión, equipo, vehículo, marcador y resultado). Emitir no cambia la visibilidad de ningún
        bot ni de su código. Una batalla de práctica con bots no públicos se rechaza con <code>battle_not_public</code>;
        la de un torneo sin retransmisión pública, con <code>tournament_not_broadcastable</code>.
      </p>
    </div>
  );
}
