/**
 * V1 ADM-3 · Administración → Usuarios. Sustituye al antiguo cuadro de «userId + roles separados por coma».
 *
 * MODELO DE UN ADMINISTRADOR: UN solo admin gestiona toda la plataforma desde esta pantalla; ninguna acción pide a otro
 * admin. Cada acción sensible (roles de admin, bloquear/desbloquear —también a otro admin—, token de recuperación de
 * cualquier cuenta) pasa por `ConfirmDestructive`: frase literal + reautenticación (contraseña y TOTP si lo tienes) y
 * queda en la auditoría. La consola sólo es el último recurso de recuperación.
 *
 *  - Listado paginado por cursor (`GET /admin/users`) con búsqueda por nombre o email; sin datos sensibles.
 *  - Roles: al abrir el editor se piden los roles REALES de la cuenta por id (`GET /admin/users/{id}`).
 *  - El token de recuperación se muestra UNA vez, con su caducidad, para entregárselo al usuario fuera de banda.
 * La autorización real la hace la API (sólo admin); aquí la UI no calcula ni decide nada de seguridad.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type Me } from "../../api.js";
import { Button, EmptyState, ErrorState, FormError, LoadingState, Panel, StatusBadge } from "../../ui/primitives.js";
import { ConfirmDestructive, type ConfirmCredentials } from "./ConfirmDestructive.js";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  status: "active" | "blocked";
  twoFactorEnabled: boolean;
  recoveryPending: boolean;
  createdAt: string;
  blockedAt: string | null;
}
interface Page {
  items: AdminUser[];
  nextCursor?: string;
}
interface IssuedToken {
  token: string;
  expiresAt: string;
  userId: string;
  label: string;
}

/** Roles asignables desde la web (los del servidor, sin «visitor», que es el anónimo). */
export const ASSIGNABLE_ROLES = ["user", "developer", "team_captain", "organizer", "moderator", "admin"] as const;

type Action =
  | { kind: "roles"; user: AdminUser; roles: string[]; reauth: boolean }
  | { kind: "status"; user: AdminUser; to: "active" | "blocked" }
  | { kind: "token"; user: AdminUser };

/** Frase literal de cada acción (la fija la web: las acciones son directas, sin orden del servidor). */
export function userActionPhrase(a: Action): string {
  switch (a.kind) {
    case "roles":
      return `CAMBIAR ROLES ${a.user.email}`;
    case "status":
      return `${a.to === "blocked" ? "BLOQUEAR" : "DESBLOQUEAR"} ${a.user.email}`;
    case "token":
      return `RECUPERAR ${a.user.email}`;
  }
}

export function UsersPage(props: { me: Me }) {
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [items, setItems] = useState<AdminUser[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [rolesDraft, setRolesDraft] = useState<{ id: string; roles: string[]; original: string[] } | null>(null);

  const fetchPage = useCallback(async (query: string, cursor?: string): Promise<Page> => {
    const qs = new URLSearchParams({ limit: "20" });
    if (query) qs.set("q", query);
    if (cursor) qs.set("cursor", cursor);
    return api<Page>("GET", `/admin/users?${qs.toString()}`);
  }, []);

  const reload = useCallback(
    (query: string) => {
      setLoading(true);
      setLoadError(null);
      fetchPage(query)
        .then((p) => {
          setItems(p.items);
          setNext(p.nextCursor);
        })
        .catch((e) => setLoadError(e))
        .finally(() => setLoading(false));
    },
    [fetchPage],
  );

  useEffect(() => {
    reload("");
  }, [reload]);

  function search(e: FormEvent) {
    e.preventDefault();
    setApplied(q.trim());
    reload(q.trim());
  }

  async function more() {
    if (!next) return;
    setBusy(true);
    try {
      const p = await fetchPage(applied, next);
      setItems((cur) => [...cur, ...p.items]);
      setNext(p.nextCursor);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  /** Abre el editor de roles con los roles REALES de la cuenta (por id), no los de la página cargada. */
  async function openRoles(u: AdminUser) {
    setActionError(null);
    setBusy(true);
    try {
      const fresh = await api<AdminUser>("GET", `/admin/users/${u.id}`);
      setRolesDraft({ id: u.id, roles: fresh.roles, original: fresh.roles });
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  async function onConfirm(c: ConfirmCredentials) {
    const a = action;
    if (!a) return;
    setBusy(true);
    setActionError(null);
    try {
      const reauth = { password: c.password, ...(c.totp ? { totp: c.totp } : {}) };
      if (a.kind === "roles") {
        // Conceder o quitar «admin» (a quien sea) exige reautenticación; el resto de cambios, no.
        if (a.reauth) await api("PUT", `/users/${a.user.id}/roles`, { roles: a.roles, ...reauth }, { reauth: true });
        else await api("PUT", `/users/${a.user.id}/roles`, { roles: a.roles });
        setNotice(`Roles de ${a.user.email} actualizados.`);
      } else if (a.kind === "status") {
        await api("PUT", `/admin/users/${a.user.id}/status`, { status: a.to, ...reauth }, { reauth: true });
        setNotice(
          a.to === "blocked" ? `${a.user.email} bloqueado: sesiones cerradas.` : `${a.user.email} desbloqueado.`,
        );
      } else {
        const r = await api<{ token: string; expiresAt: string; userId: string }>(
          "POST",
          `/admin/users/${a.user.id}/recovery-token`,
          reauth,
          { reauth: true },
        );
        setIssued({ ...r, label: a.user.email });
      }
      setAction(null);
      setRolesDraft(null);
      reload(applied);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <LoadingState label="los usuarios" />;
  if (loadError) return <ErrorState label="los usuarios" error={loadError} onRetry={() => reload(applied)} />;

  const confirmProps = (() => {
    if (!action) return null;
    const phrase = userActionPhrase(action);
    if (action.kind === "roles") {
      const touchesAdmin = action.reauth;
      return {
        title: `Cambiar los roles de ${action.user.email}`,
        impact: {
          summary: `Los roles pasarán a ser: ${action.roles.length > 0 ? action.roles.join(", ") : "ninguno (sin acceso)"}. Sustituyen a los actuales y anulan los tokens de recuperación abiertos de la cuenta.${touchesAdmin ? " Incluye el rol de administrador: pide tu contraseña." : ""}`,
          counts: {},
        },
        phrase,
        askPassword: touchesAdmin,
      };
    }
    if (action.kind === "status") {
      return {
        title: action.to === "blocked" ? `Bloquear a ${action.user.email}` : `Desbloquear a ${action.user.email}`,
        impact: {
          summary:
            action.to === "blocked"
              ? "No podrá iniciar sesión; se cierran todas sus sesiones y se anulan sus tokens de recuperación. Nunca puede quedar 0 administradores activos."
              : "Podrá volver a iniciar sesión.",
          counts: {},
        },
        phrase,
        askPassword: true,
      };
    }
    return {
      title: `Emitir un token de recuperación para ${action.user.email}`,
      impact: {
        summary:
          "Se genera un token de un solo uso (30 min) que anula los anteriores. Quien lo tenga fijará la contraseña de la cuenta y se cerrarán sus sesiones. Se muestra una sola vez.",
        counts: {},
      },
      phrase,
      askPassword: true,
    };
  })();

  return (
    <Panel data-testid="users-panel">
      <h2>Usuarios</h2>
      <form onSubmit={search} role="search" data-testid="users-search-form">
        <label>
          Buscar por nombre o email{" "}
          <input
            aria-label="buscar usuario"
            data-testid="users-search"
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>{" "}
        <Button type="submit" data-testid="users-search-submit">
          Buscar
        </Button>
      </form>

      {notice && (
        <p role="status" data-testid="users-notice">
          {notice}
        </p>
      )}
      <FormError error={actionError} data-testid="users-error" />

      {issued && (
        <div className="card" role="alert" data-testid="recovery-token-card">
          <h3>Token de recuperación para {issued.label}</h3>
          <p>
            <strong>Se muestra una sola vez.</strong> Entrégaselo al usuario fuera de banda (en persona o por un canal
            que controle él); no lo pegues en un chat compartido. Caduca el{" "}
            {new Date(issued.expiresAt).toLocaleString()} y vale para un solo uso en <code>#/reset</code>.
          </p>
          <p>
            <code data-testid="recovery-token-value">{issued.token}</code>
          </p>
          <Button data-testid="recovery-token-close" onClick={() => setIssued(null)}>
            Ya lo he entregado: ocultar
          </Button>
        </div>
      )}

      {confirmProps && (
        <ConfirmDestructive
          key={`${action!.kind}-${action!.user.id}-${"to" in action! ? action.to : ""}`}
          {...confirmProps}
          needsTotp={props.me.twoFactorEnabled}
          error={actionError}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={() => {
            setAction(null);
            setActionError(null);
          }}
        />
      )}

      {items.length === 0 ? (
        <EmptyState
          data-testid="users-empty"
          message={applied ? `Ningún usuario coincide con «${applied}».` : "No hay usuarios."}
        />
      ) : (
        <table className="stack-table" data-testid="users-table">
          <thead>
            <tr>
              <th>Usuario</th>
              <th>Roles</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {items.map((u) => {
              const isMe = u.id === props.me.id;
              const editing = rolesDraft?.id === u.id;
              return (
                <tr key={u.id} data-testid={`user-row-${u.id}`}>
                  <td data-label="Usuario">
                    <strong>{u.displayName}</strong>
                    <br />
                    <small>{u.email}</small>
                    {u.twoFactorEnabled && <small> · 2FA</small>}
                  </td>
                  <td data-label="Roles">
                    {editing ? (
                      <fieldset>
                        {ASSIGNABLE_ROLES.map((r) => (
                          <label key={r} style={{ display: "block" }}>
                            <input
                              type="checkbox"
                              data-testid={`role-${u.id}-${r}`}
                              checked={rolesDraft.roles.includes(r)}
                              onChange={(e) =>
                                setRolesDraft({
                                  ...rolesDraft,
                                  roles: e.target.checked
                                    ? [...rolesDraft.roles, r]
                                    : rolesDraft.roles.filter((x) => x !== r),
                                })
                              }
                            />{" "}
                            {r}
                          </label>
                        ))}
                      </fieldset>
                    ) : (
                      u.roles.join(", ") || "—"
                    )}
                  </td>
                  <td data-label="Estado">
                    {u.status === "blocked" ? (
                      <StatusBadge variant="error">bloqueada</StatusBadge>
                    ) : (
                      <StatusBadge variant="ok">activa</StatusBadge>
                    )}
                    {u.recoveryPending && (
                      <>
                        {" "}
                        <StatusBadge variant="warn">recuperación pendiente</StatusBadge>
                      </>
                    )}
                  </td>
                  <td data-label="Acciones">
                    {editing ? (
                      <>
                        <Button
                          data-testid={`roles-save-${u.id}`}
                          onClick={() => {
                            const touchesAdmin =
                              rolesDraft.original.includes("admin") !== rolesDraft.roles.includes("admin");
                            setAction({ kind: "roles", user: u, roles: rolesDraft.roles, reauth: touchesAdmin });
                          }}
                        >
                          Guardar roles
                        </Button>{" "}
                        <Button variant="link" onClick={() => setRolesDraft(null)}>
                          Descartar
                        </Button>
                      </>
                    ) : (
                      <Button data-testid={`roles-edit-${u.id}`} disabled={busy} onClick={() => void openRoles(u)}>
                        Roles
                      </Button>
                    )}{" "}
                    <Button
                      data-testid={`status-${u.id}`}
                      onClick={() =>
                        setAction({ kind: "status", user: u, to: u.status === "blocked" ? "active" : "blocked" })
                      }
                    >
                      {u.status === "blocked" ? "Desbloquear" : "Bloquear"}
                    </Button>{" "}
                    {!isMe && u.status === "active" && (
                      <Button data-testid={`recover-${u.id}`} onClick={() => setAction({ kind: "token", user: u })}>
                        Token de recuperación
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {next && (
        <p>
          <Button data-testid="users-more" disabled={busy} onClick={() => void more()}>
            Cargar más
          </Button>
        </p>
      )}
    </Panel>
  );
}
