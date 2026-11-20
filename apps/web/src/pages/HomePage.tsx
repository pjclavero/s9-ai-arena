/**
 * UX-A · Portada de S9.
 *
 *  - `LandingIntro` (G-01): lo que ve un visitante SIN sesión junto al acceso:
 *    qué es S9, cómo se juega y los pasos para empezar, con enlace a la guía.
 *  - `HomePage`: la home autenticada (#/) con la checklist de PRIMEROS PASOS.
 *    Cada paso se marca con el ESTADO REAL de la API (bots, loadouts, versiones,
 *    equipos y batallas del usuario), nunca con flags locales: si alguien borra
 *    un bot, el paso vuelve a quedar pendiente. Si una lectura falla, se dice y
 *    se ofrece reintentar (no se pinta una checklist vacía «a medias»).
 */
import { api, type Me } from "../api.js";
import { useResource, ResourceView } from "../resource.js";
import { HOW_IT_PLAYS, JOURNEY, WHAT_IS_S9 } from "../help/content.js";

export function LandingIntro() {
  return (
    <section className="card" aria-labelledby="landing-title" data-testid="landing">
      <h2 id="landing-title">Programa un bot, equípalo y hazlo combatir</h2>
      <p>{WHAT_IS_S9}</p>
      <p>{HOW_IT_PLAYS}</p>
      <h3>Cómo empezar</h3>
      <ol data-testid="landing-steps">
        <li>Crea tu cuenta con el formulario de esta página (es gratis y entras directamente).</li>
        <li>Crea tu primer bot, elige su equipamiento (loadout) y sube su código en Python o JavaScript.</li>
        <li>Envíalo a validación y, si la supera, publícalo.</li>
        <li>Con dos bots publicados ya puedes lanzar una batalla de práctica y verla en directo o en replay.</li>
      </ol>
      <p>
        <a href="#/help">Lee la guía paso a paso y el glosario</a> · sin cuenta también puedes ver{" "}
        <a href="#/live">las batallas en directo</a> y <a href="#/ranking">el ranking</a>.
      </p>
    </section>
  );
}

/** Lo que la checklist necesita saber del usuario, leído de la API. */
export interface FirstStepsFacts {
  bots: number;
  botsWithLoadout: number;
  botsWithCode: number;
  /** Bots con alguna versión validated o published. */
  botsValidated: number;
  /** Bots con alguna versión published (latestPublishedVersion). */
  botsPublished: number;
  inTeam: boolean;
  /** Batallas en las que participa alguno de sus bots. */
  battles: number;
}

export interface FirstStep {
  id: string;
  title: string;
  done: boolean;
  how: string;
  href: string;
  linkLabel: string;
}

/**
 * Pasos del recorrido con su estado. Un paso posterior implica los anteriores
 * del MISMO bot (publicar exige validar, y validar exige código y loadout), así
 * que un bot publicado marca también loadout/código/validación aunque no se
 * hayan contado por separado.
 */
export function computeFirstSteps(f: FirstStepsFacts): FirstStep[] {
  const done: Record<string, boolean> = {
    account: true,
    bot: f.bots >= 1,
    loadout: f.botsWithLoadout >= 1 || f.botsPublished >= 1,
    code: f.botsWithCode >= 1 || f.botsPublished >= 1,
    validated: f.botsValidated >= 1 || f.botsPublished >= 1,
    published: f.botsPublished >= 1,
    secondBot: f.botsPublished >= 2,
    team: f.inTeam,
    battle: f.battles >= 1,
  };
  return JOURNEY.map((s) => ({ ...s, done: done[s.id] ?? false }));
}

interface BotRow {
  id: string;
  latestPublishedVersion?: number | null;
}
interface VersionRow {
  state: string;
}

/** Lee de la API los hechos de la checklist. Cualquier fallo se PROPAGA. */
export async function loadFirstStepsFacts(me: Me): Promise<FirstStepsFacts> {
  const [bots, teams, battles] = await Promise.all([
    api<{ items: BotRow[] }>("GET", `/bots?ownerId=${encodeURIComponent(me.id)}&limit=100`),
    api<{ items: { isMember?: boolean }[] }>("GET", "/teams?limit=100"),
    api<{ items: { participants?: { botId: string }[] }[] }>("GET", "/battles?limit=100"),
  ]);
  const mine = bots.items ?? [];
  // Detalle por bot (loadouts y versiones) de los primeros: quien tiene más de
  // diez bots ya ha pasado por estos pasos.
  const detail = await Promise.all(
    mine.slice(0, 10).map(async (b) => {
      const [loadouts, versions] = await Promise.all([
        api<unknown[]>("GET", `/bots/${encodeURIComponent(b.id)}/loadouts`),
        api<VersionRow[]>("GET", `/bots/${encodeURIComponent(b.id)}/versions`),
      ]);
      return {
        loadout: loadouts.length > 0,
        code: versions.length > 0,
        validated: versions.some((v) => v.state === "validated" || v.state === "published"),
      };
    }),
  );
  const ids = new Set(mine.map((b) => b.id));
  return {
    bots: mine.length,
    botsWithLoadout: detail.filter((d) => d.loadout).length,
    botsWithCode: detail.filter((d) => d.code).length,
    botsValidated: detail.filter((d) => d.validated).length,
    botsPublished: mine.filter((b) => b.latestPublishedVersion != null).length,
    inTeam: (teams.items ?? []).some((t) => t.isMember === true),
    battles: (battles.items ?? []).filter((x) => (x.participants ?? []).some((p) => ids.has(p.botId))).length,
  };
}

export function FirstStepsChecklist(props: { steps: FirstStep[] }) {
  const { steps } = props;
  const next = steps.find((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <section className="card" aria-labelledby="first-steps-title" data-testid="first-steps">
      <h3 id="first-steps-title">Primeros pasos</h3>
      <p data-testid="first-steps-progress">
        {doneCount} de {steps.length} completados.{" "}
        {next ? (
          <>
            Siguiente paso: <strong data-testid="first-steps-next">{next.title}</strong> —{" "}
            <a href={next.href}>{next.linkLabel}</a>
          </>
        ) : (
          <strong data-testid="first-steps-next">Has completado el recorrido: ya sabes jugar en S9.</strong>
        )}
      </p>
      <ol>
        {steps.map((s) => (
          <li
            key={s.id}
            data-testid={`first-step-${s.id}`}
            data-done={s.done ? "true" : "false"}
            aria-current={next?.id === s.id ? "step" : undefined}
          >
            <span className={s.done ? "ok" : next?.id === s.id ? "warn" : undefined}>
              {s.done ? "✔ Hecho" : next?.id === s.id ? "➜ Siguiente" : "○ Pendiente"}
            </span>{" "}
            <strong>{s.title}</strong>
            {!s.done && (
              <>
                <br />
                {s.how} <a href={s.href}>{s.linkLabel}</a>
              </>
            )}
          </li>
        ))}
      </ol>
      <p>
        ¿Dudas con algún término (loadout, runtime, validated…)? <a href="#/help">Consulta la ayuda y el glosario</a>.
      </p>
    </section>
  );
}

export function HomePage(props: { me: Me }) {
  const [facts, reload] = useResource(() => loadFirstStepsFacts(props.me), [props.me.id]);
  return (
    <div data-testid="home-page">
      <h2>Inicio</h2>
      <p>{WHAT_IS_S9}</p>
      <ResourceView resource={facts} label="tus primeros pasos" onRetry={reload}>
        {(f) => <FirstStepsChecklist steps={computeFirstSteps(f)} />}
      </ResourceView>
    </div>
  );
}
