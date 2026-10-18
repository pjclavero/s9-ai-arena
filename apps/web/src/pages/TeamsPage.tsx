/**
 * T7.4 + FC-C (TD-011) · Gestión COMPLETA de equipos desde la web:
 * crear, renombrar, borrar; añadir miembro (por email, sin teclear UUID) y quitarlo;
 * asignar un bot propio al equipo y quitarlo. Todo persiste en la API; la
 * autorización la hace el servidor (capitán / dueño del bot): la UI solo oculta.
 *
 * Errores: nunca se tragan (antes `refresh().catch(() => {})`). Un fallo de carga se
 * anuncia con role="alert" y botón de reintento; un fallo de acción, también.
 */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";
import { Panel, Button, ErrorState, FormError } from "../ui/primitives.js";

interface TeamMember {
  userId: string;
  displayName: string;
  role: "captain" | "member";
}
interface TeamBot {
  id: string;
  name: string;
  mine?: boolean;
}
export interface Team {
  id: string;
  name: string;
  memberCount: number;
  botCount: number;
  isCaptain?: boolean;
  isMember?: boolean;
  members?: TeamMember[];
  bots?: TeamBot[];
}
interface MyBot {
  id: string;
  name: string;
  teamId?: string | null;
}

export function TeamsPage(props: { me: Me }) {
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [myBots, setMyBots] = useState<MyBot[]>([]);
  // REVIEW (R4.8) · se guarda el FALLO ORIGINAL (no su texto) para que los
  // componentes comunes de D distingan 403/404/5xx/timeout/red.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [invite, setInvite] = useState<Record<string, string>>({});
  const [rename, setRename] = useState<Record<string, string>>({});
  const [botPick, setBotPick] = useState<Record<string, string>>({});

  async function refresh() {
    setLoadError(null);
    try {
      const [page, bots] = await Promise.all([
        api<{ items: Team[] }>("GET", "/teams?limit=100"),
        api<{ items: MyBot[] }>("GET", `/bots?limit=100&ownerId=${encodeURIComponent(props.me.id)}`),
      ]);
      setTeams(page.items);
      setMyBots(bots.items ?? []);
    } catch (e) {
      setTeams(null);
      setLoadError(e ?? new Error("error desconocido"));
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(label: string, fn: () => Promise<unknown>) {
    setError(null);
    setNotice("");
    try {
      await fn();
      setNotice(label);
      await refresh();
    } catch (e) {
      setError(e ?? new Error("error desconocido"));
    }
  }

  const mine = (teams ?? []).filter((t) => t.isMember);
  const others = (teams ?? []).filter((t) => !t.isMember);

  return (
    <Panel>
      <h2>Equipos</h2>
      <input
        aria-label="nuevo-equipo"
        placeholder="nombre del equipo"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />{" "}
      <Button
        onClick={() =>
          act(`Equipo «${name}» creado.`, async () => {
            await api("POST", "/teams", { name });
            setName("");
          })
        }
      >
        Crear equipo
      </Button>
      <FormError error={error} data-testid="teams-error" />
      {notice && (
        <p className="ok" role="status" data-testid="teams-notice">
          {notice}
        </p>
      )}
      {loadError !== null && (
        <div data-testid="teams-load-error">
          <ErrorState label="los equipos" error={loadError} onRetry={() => void refresh()} />
        </div>
      )}
      {teams === null && loadError === null && <p>Cargando equipos…</p>}
      {mine.map((t) => (
        <section key={t.id} className="card" data-testid={`team-${t.name}`} aria-label={`equipo ${t.name}`}>
          <h3>
            {t.name} <small>{t.isCaptain ? "· eres capitán" : "· eres miembro"}</small>
          </h3>
          {t.isCaptain && (
            <p>
              <input
                aria-label={`renombrar-${t.name}`}
                placeholder="nuevo nombre"
                value={rename[t.id] ?? ""}
                onChange={(e) => setRename((s) => ({ ...s, [t.id]: e.target.value }))}
              />{" "}
              <Button
                onClick={() =>
                  act("Equipo renombrado.", () => api("PATCH", `/teams/${t.id}`, { name: rename[t.id] ?? "" }))
                }
              >
                Renombrar
              </Button>{" "}
              <Button
                onClick={() => {
                  if (!window.confirm(`¿Borrar el equipo «${t.name}»? Sus bots no se borran.`)) return;
                  void act(`Equipo «${t.name}» borrado.`, () => api("DELETE", `/teams/${t.id}`));
                }}
              >
                Borrar equipo
              </Button>
            </p>
          )}

          <h4>Miembros ({t.memberCount})</h4>
          <ul>
            {(t.members ?? []).map((m) => (
              <li key={m.userId}>
                {m.displayName} <small>({m.role === "captain" ? "capitán" : "miembro"})</small>
                {t.isCaptain && m.role !== "captain" && (
                  <>
                    {" "}
                    <Button
                      aria-label={`quitar-miembro-${m.displayName}`}
                      onClick={() =>
                        act(`${m.displayName} ya no es miembro.`, () =>
                          api("DELETE", `/teams/${t.id}/members/${encodeURIComponent(m.userId)}`),
                        )
                      }
                    >
                      Quitar
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          {t.isCaptain && (
            <p>
              <input
                aria-label={`invitar-${t.name}`}
                placeholder="email del usuario"
                type="email"
                value={invite[t.id] ?? ""}
                onChange={(e) => setInvite((s) => ({ ...s, [t.id]: e.target.value }))}
              />{" "}
              <Button
                onClick={() =>
                  act("Miembro añadido.", async () => {
                    await api("POST", `/teams/${t.id}/members`, { email: invite[t.id] ?? "" });
                    setInvite((s) => ({ ...s, [t.id]: "" }));
                  })
                }
              >
                Añadir miembro
              </Button>
            </p>
          )}

          <h4>Bots del equipo ({t.botCount})</h4>
          <ul>
            {(t.bots ?? []).map((b) => (
              <li key={b.id}>
                {b.name}
                {(b.mine || t.isCaptain) && (
                  <>
                    {" "}
                    <Button
                      aria-label={`quitar-bot-${b.name}`}
                      onClick={() =>
                        act(`Bot ${b.name} fuera del equipo.`, () => api("DELETE", `/teams/${t.id}/bots/${b.id}`))
                      }
                    >
                      Quitar del equipo
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
          <p>
            <select
              aria-label={`añadir-bot-${t.name}`}
              value={botPick[t.id] ?? ""}
              onChange={(e) => setBotPick((s) => ({ ...s, [t.id]: e.target.value }))}
            >
              <option value="">— uno de mis bots —</option>
              {myBots
                .filter((b) => b.teamId !== t.id)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>{" "}
            <Button
              disabled={!botPick[t.id]}
              onClick={() =>
                act("Bot añadido al equipo.", () => api("POST", `/teams/${t.id}/bots`, { botId: botPick[t.id] }))
              }
            >
              Añadir bot
            </Button>
          </p>
        </section>
      ))}
      {others.length > 0 && (
        <>
          <h3>Otros equipos</h3>
          <table>
            <tbody>
              {others.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    {t.memberCount} miembros · {t.botCount} bots
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Panel>
  );
}
