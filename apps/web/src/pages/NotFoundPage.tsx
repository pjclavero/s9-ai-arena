/**
 * FC-D (D8, TD-022) · Página 404 del panel. Antes cualquier hash desconocido
 * caía en «Mis bots» sin aviso. Ofrece volver atrás y los destinos principales.
 */
export function NotFoundPage(props: { route: string }) {
  return (
    <div className="card" data-testid="not-found" role="alert">
      <h2>Página no encontrada</h2>
      <p>
        La dirección <code>{props.route || "(vacía)"}</code> no corresponde a ninguna pantalla.
      </p>
      <p>
        <button type="button" onClick={() => window.history.back()}>
          Volver
        </button>{" "}
        <a href="#/bots">Mis bots</a> · <a href="#/battles">Batallas</a> · <a href="#/replays">Replays</a>
      </p>
    </div>
  );
}
