/** T7.4 · Gestión de equipos: crear (capitán automático), invitar y expulsar. */
import { useEffect, useState } from "react";
import { api, type Me } from "../api.js";

interface Team {
  id: string;
  name: string;
  captainId: string;
  memberIds: string[];
}

export function TeamsPage(props: { me: Me }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [name, setName] = useState("");
  const [invite, setInvite] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  async function refresh() {
    const page = await api<{ items: Team[] }>("GET", "/teams");
    setTeams(page.items);
  }
  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  return (
    <div className="card">
      <h2>Equipos</h2>
      <input
        aria-label="nuevo-equipo"
        placeholder="nombre del equipo"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />{" "}
      <button
        onClick={async () => {
          try {
            await api("POST", "/teams", { name });
            setName("");
            await refresh();
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Crear equipo
      </button>
      {error && <p className="error">{error}</p>}
      <table>
        <tbody>
          {teams.map((t) => {
            const isCaptain = t.captainId === props.me.id;
            return (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>
                  {t.memberIds.length} miembros{isCaptain ? " · eres capitán" : ""}
                </td>
                <td>
                  {isCaptain && (
                    <>
                      <input
                        aria-label={`invitar-${t.name}`}
                        placeholder="userId a invitar"
                        value={invite[t.id] ?? ""}
                        onChange={(e) => setInvite((s) => ({ ...s, [t.id]: e.target.value }))}
                      />{" "}
                      <button
                        onClick={async () => {
                          try {
                            await api("POST", `/teams/${t.id}/members`, { userId: invite[t.id] });
                            await refresh();
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        Invitar
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
