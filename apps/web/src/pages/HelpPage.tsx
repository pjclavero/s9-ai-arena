/**
 * UX-A (G-01) · Guía integrada en la web: #/help (alias #/ayuda y #/docs, que
 * antes daban «Página no encontrada»). Es PÚBLICA: un visitante sin cuenta
 * tiene que poder leer qué es S9 y qué hacer primero antes de registrarse.
 *
 * Contenido: qué es S9, el recorrido paso a paso, el glosario de los términos
 * que la web muestra tal cual y enlaces a la documentación del repo público.
 * El texto vive en help/content.ts (mismo recorrido que la landing y la checklist).
 */
import { DOC_LINKS, GLOSSARY, HOW_IT_PLAYS, JOURNEY, WHAT_IS_S9 } from "../help/content.js";

export function HelpPage(props: { loggedIn: boolean }) {
  return (
    <div data-testid="help-page">
      <h2>Ayuda y guía de S9 AI Arena</h2>

      <section className="card" aria-labelledby="help-what">
        <h3 id="help-what">Qué es S9</h3>
        <p>{WHAT_IS_S9}</p>
        <p>{HOW_IT_PLAYS}</p>
        {/* Sin índice de anclas: el router es por hash y `#seccion` sería una ruta (⇒ 404). */}
      </section>

      <section className="card" aria-labelledby="help-journey-title">
        <h3 id="help-journey-title">Recorrido paso a paso: de la cuenta a la primera batalla</h3>
        <ol data-testid="help-journey">
          {JOURNEY.map((s) => (
            <li key={s.id}>
              <strong>{s.title}.</strong> {s.how}{" "}
              {/* Sin sesión los enlaces del panel llevan al acceso: se dice en vez de sorprender. */}
              {s.id === "account" ? (
                !props.loggedIn && <a href={s.href}>{s.linkLabel}</a>
              ) : (
                <a href={s.href}>
                  {s.linkLabel}
                  {props.loggedIn ? "" : " (requiere iniciar sesión)"}
                </a>
              )}
            </li>
          ))}
        </ol>
        <p>
          ¿Algo falla? Cada pantalla dice qué ha pasado (permiso, inexistente, servidor no disponible, sin respuesta)
          y ofrece «Reintentar». Si una versión queda <code>rejected</code>, el motivo aparece junto a la versión.
        </p>
      </section>

      <section className="card" aria-labelledby="help-glossary-title">
        <h3 id="help-glossary-title">Glosario</h3>
        <dl data-testid="help-glossary">
          {GLOSSARY.map((g) => (
            <div key={g.id} id={`glosario-${g.id}`}>
              <dt>
                <strong>{g.term}</strong>
              </dt>
              <dd>{g.definition}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card" aria-labelledby="help-docs-title">
        <h3 id="help-docs-title">Documentación</h3>
        <p>La documentación completa y los SDK están en el repositorio público del proyecto (se abre en otra pestaña):</p>
        <ul data-testid="help-docs">
          {DOC_LINKS.map((d) => (
            <li key={d.href}>
              <a href={d.href} target="_blank" rel="noopener noreferrer">
                {d.label}
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
