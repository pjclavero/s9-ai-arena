/**
 * V1 ADM-3 · Administración → Usuarios. Sustituye al antiguo cuadro de «userId + roles separados por coma».
 *
 *  - Listado paginado por cursor (`GET /admin/users`) con búsqueda por nombre o email; sin datos sensibles.
 *  - Acciones por usuario: roles, bloquear/desbloquear y emitir un token de recuperación de contraseña. Las destructivas
 *    pasan por `ConfirmDestructive` (frase literal; contraseña y TOTP donde el servidor reautentica).
 *  - Recuperación de una cuenta ADMIN: la solicita quien emite, la aprueba OTRO administrador (orden
 *    `user.recovery_admin` de ADM-1) y quien la solicitó emite entonces el token. Con un solo administrador la vía es la
 *    CLI local (el servidor responde 409 `second_admin_unavailable` y aquí se explica).
 *  - El token se muestra UNA vez, con su caducidad, para entregárselo al usuario fuera de banda.
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
export interface RecoveryOperation {
  id: string;
  kind: string;
  params: { userId?: string };
  status: string;
  confirmPhrase: string | null;
  requestedBy: string | null;
  impact: { summary: string; counts: Record<string, number> };
}
interface IssuedToken {
  token: string;
  expiresAt: string;
  userId: string;
  label: string;
}

/** Roles asignables desde la web (los del servidor, sin «visitor», que es el anónimo). */
export const ASSIGNABLE_ROLES = ["user", "developer", "team_captain", "organizer", "moderator", "admin"] as const;
export const RECOVERY_KIND = "user.recovery_admin";
export const REVOKE_KIND = "user.revoke_admin";
export const GRANT_KIND = "user.grant_admin";
export const BLOCK_KIND = "user.block_admin";
export const UNBLOCK_KIND = "user.unblock_admin";
const USER_KINDS = [RECOVERY_KIND, REVOKE_KIND, GRANT_KIND, BLOCK_KIND, UNBLOCK_KIND];
const KIND_PHRASE: Record<string, string> = {
  [REVOKE_KIND]: "QUITAR ADMIN",
  [GRANT_KIND]: "CONCEDER ADMIN",
  [BLOCK_KIND]: "BLOQUEAR ADMIN",
  [UNBLOCK_KIND]: "DESBLOQUEAR ADMIN",
};
const KIND_TEXT: Record<string, string> = {
  [RECOVERY_KIND]: "recuperar a ",
  [REVOKE_KIND]: "quitar el rol admin a ",
  [GRANT_KIND]: "conceder el rol admin a ",
  [BLOCK_KIND]: "bloquear a la cuenta admin ",
  [UNBLOCK_KIND]: "desbloquear a la cuenta admin ",
};

type Action =
  | { kind: "roles"; user: AdminUser; roles: string[]; reauth: boolean }
  | { kind: "requestRecovery"; user: AdminUser }
  | { kind: "requestRevoke"; user: AdminUser }
  | { kind: "applyOp"; op: RecoveryOperation; label: string }
  | { kind: "cancelOp"; op: RecoveryOperation }
  | { kind: "status"; user: AdminUser; to: "active" | "blocked" }
  | { kind: "token"; user: AdminUser }
  | { kind: "approve"; op: RecoveryOperation }
  | { kind: "issueAdmin"; op: RecoveryOperation; label: string };

const short = (id: string) => id.slice(0, 8);

/** Frase literal de cada acción de usuario (la web la fija para acciones directas; la de las órdenes la fija el servidor). */
export function userActionPhrase(a: Exclude<Action, { kind: "approve" } | { kind: "issueAdmin" }>): string {
  switch (a.kind) {
    case "roles":
      return `CAMBIAR ROLES ${a.user.email}`;
    case "status":
      return `${a.to === "blocked" ? "BLOQUEAR" : "DESBLOQUEAR"} ${a.user.email}`;
    case "token":
      return `RECUPERAR ${a.user.email}`;
    case "requestRecovery":
      return `SOLICITAR RECUPERACION ${a.user.email}`;
    case "requestRevoke":
      return `SOLICITAR QUITAR ADMIN ${a.user.email}`;
    case "applyOp":
      return `${KIND_PHRASE[a.op.kind] ?? "APLICAR"} ${short(a.op.params.userId ?? "")}`;
    case "cancelOp":
      return `CANCELAR ${short(a.op.params.userId ?? "")}`;
  }
}

function errorCode(e: unknown): string | undefined {
  return (e as { body?: { error?: string } })?.body?.error;
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
  const [ops, setOps] = useState<RecoveryOperation[]>([]);
  const [rolesDraft, setRolesDraft] = useState<{ id: string; roles: string[] } | null>(null);

  const fetchPage = useCallback(async (query: string, cursor?: string): Promise<Page> => {
    const qs = new URLSearchParams({ limit: "20" });
    if (query) qs.set("q", query);
    if (cursor) qs.set("cursor", cursor);
    return api<Page>("GET", `/admin/users?${qs.toString()}`);
  }, []);

  const loadOps = useCallback(async () => {
    try {
      const all = await api<RecoveryOperation[]>("GET", "/admin/operations?limit=50");
      setOps(
        all.filter(
          (o) => USER_KINDS.includes(o.kind) && (o.status === "awaiting_confirmation" || o.status === "pending"),
        ),
      );
    } catch {
      setOps([]); // las aprobaciones son accesorias: el listado de usuarios no depende de ellas
    }
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
      void loadOps();
    },
    [fetchPage, loadOps],
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

  const labelOf = (userId?: string) => {
    const u = items.find((x) => x.id === userId);
    return u ? u.email : userId ? short(userId) : "?";
  };

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }

  /** Solicita una orden `user.*` (aprobación de otro admin); si no hay quien pueda aprobar, explica la vía local. */
  async function requestOrder(kind: string, user: AdminUser, reauth: Record<string, string>) {
    try {
      await api("POST", "/admin/operations", { kind, params: { userId: user.id }, ...reauth }, { reauth: true });
      setNotice(`Solicitada la aprobación de otro administrador para ${KIND_TEXT[kind]}${user.email}.`);
      await loadOps();
    } catch (e) {
      if (errorCode(e) !== "second_admin_unavailable") throw e;
      setNotice(
        kind === RECOVERY_KIND
          ? "No hay otro administrador activo que pueda aprobar. Usa la recuperación local por consola (cli.ts reset-password), descrita en la guía de operación."
          : "No hay otro administrador activo que pueda aprobar (los promovidos por ti no cuentan). Hazlo por consola o, para quitar el rol, que la propia cuenta se lo quite (reautenticada).",
      );
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
        // Conceder o quitarse «admin» exige reautenticación (el servidor responde 401 sin ella).
        const grantsOther = a.roles.includes("admin") && !a.user.roles.includes("admin") && a.user.id !== props.me.id;
        try {
          if (a.reauth) await api("PUT", `/users/${a.user.id}/roles`, { roles: a.roles, ...reauth }, { reauth: true });
          else await api("PUT", `/users/${a.user.id}/roles`, { roles: a.roles });
          setNotice(`Roles de ${a.user.email} actualizados.`);
        } catch (e) {
          // Con otro admin activo, conceder admin necesita la aprobación de otro: se solicita la orden.
          if (!(grantsOther && errorCode(e) === "second_admin_required")) throw e;
          await requestOrder(GRANT_KIND, a.user, reauth);
        }
      } else if (a.kind === "requestRecovery" || a.kind === "requestRevoke") {
        await requestOrder(a.kind === "requestRecovery" ? RECOVERY_KIND : REVOKE_KIND, a.user, reauth);
      } else if (a.kind === "applyOp") {
        const userId = a.op.params.userId!;
        if (a.op.kind === BLOCK_KIND || a.op.kind === UNBLOCK_KIND) {
          await api(
            "PUT",
            `/admin/users/${userId}/status`,
            { status: a.op.kind === BLOCK_KIND ? "blocked" : "active", ...reauth, operationId: a.op.id },
            { reauth: true },
          );
          setNotice(`Cuenta ${a.label} ${a.op.kind === BLOCK_KIND ? "bloqueada" : "desbloqueada"}.`);
        } else {
          // Los roles REALES de la cuenta, pedidos por id: la página cargada puede no contenerla o estar desfasada.
          const fresh = await api<AdminUser>("GET", `/admin/users/${userId}`);
          const roles =
            a.op.kind === GRANT_KIND
              ? [...new Set([...fresh.roles, "admin"])]
              : fresh.roles.filter((r) => r !== "admin");
          await api("PUT", `/users/${userId}/roles`, { roles, ...reauth, operationId: a.op.id }, { reauth: true });
          setNotice(
            a.op.kind === GRANT_KIND ? `Rol admin concedido a ${a.label}.` : `Rol admin retirado a ${a.label}.`,
          );
        }
      } else if (a.kind === "cancelOp") {
        await api("POST", `/admin/operations/${a.op.id}/cancel`, reauth, { reauth: true });
        setNotice("Solicitud cancelada.");
        await loadOps();
      } else if (a.kind === "status") {
        try {
          await api("PUT", `/admin/users/${a.user.id}/status`, { status: a.to, ...reauth }, { reauth: true });
          setNotice(
            a.to === "blocked" ? `${a.user.email} bloqueado: sesiones cerradas.` : `${a.user.email} desbloqueado.`,
          );
        } catch (e) {
          // Bloquear a otra cuenta admin exige la aprobación de otro admin: se solicita la orden.
          if (errorCode(e) !== "second_admin_required") throw e;
          await requestOrder(a.to === "blocked" ? BLOCK_KIND : UNBLOCK_KIND, a.user, reauth);
        }
      } else if (a.kind === "token") {
        const r = await api<{ token: string; expiresAt: string; userId: string }>(
          "POST",
          `/admin/users/${a.user.id}/recovery-token`,
          reauth,
          { reauth: true },
        );
        setIssued({ ...r, label: a.user.email });
      } else if (a.kind === "approve") {
        await api("POST", `/admin/operations/${a.op.id}/confirm`, { phrase: c.phrase, ...reauth }, { reauth: true });
        setNotice("Aprobación registrada: quien la solicitó ya puede emitir el token.");
      } else {
        const userId = a.op.params.userId!;
        const r = await api<{ token: string; expiresAt: string; userId: string }>(
          "POST",
          `/admin/users/${userId}/recovery-token`,
          { ...reauth, operationId: a.op.id },
          { reauth: true },
        );
        setIssued({ ...r, label: a.label });
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
    if (action.kind === "approve") {
      return {
        title: "Aprobar la recuperación de una cuenta de administrador",
        impact: action.op.impact,
        phrase: action.op.confirmPhrase ?? "",
        requiresSecondAdmin: true,
        askPassword: true,
      };
    }
    if (action.kind === "issueAdmin") {
      return {
        title: `Emitir el token de recuperación de ${action.label}`,
        impact: {
          summary: "Se emite un token de un solo uso (30 min) y la aprobación del segundo administrador se consume.",
          counts: {},
        },
        phrase: `EMITIR TOKEN ${short(action.op.params.userId ?? "")}`,
        askPassword: true,
      };
    }
    const phrase = userActionPhrase(action);
    if (action.kind === "requestRecovery" || action.kind === "requestRevoke") {
      const rec = action.kind === "requestRecovery";
      return {
        title: rec
          ? `Solicitar la recuperación de la cuenta de administrador ${action.user.email}`
          : `Solicitar quitar el rol admin a ${action.user.email}`,
        impact: {
          summary: rec
            ? "Hace falta la aprobación de OTRO administrador antes de poder emitir el token."
            : "Hace falta la aprobación de OTRO administrador; después tú aplicas el cambio. Quitarse el rol a uno mismo no la necesita.",
          counts: {},
        },
        phrase,
        askPassword: true,
      };
    }
    if (action.kind === "applyOp") {
      return {
        title: `Aplicar: ${KIND_TEXT[action.op.kind]}${action.label}`,
        impact: { summary: "Se consume la aprobación del segundo administrador y se aplica el cambio.", counts: {} },
        phrase,
        askPassword: true,
      };
    }
    if (action.kind === "cancelOp") {
      return {
        title: "Cancelar la solicitud",
        impact: { summary: "Se cancela la solicitud pendiente o aprobada; habrá que pedirla de nuevo.", counts: {} },
        phrase,
        askPassword: true,
      };
    }
    if (action.kind === "roles") {
      return {
        title: `Cambiar los roles de ${action.user.email}`,
        impact: {
          summary: `Los roles pasarán a ser: ${action.roles.length > 0 ? action.roles.join(", ") : "ninguno (sin acceso)"}. Sustituyen a los actuales.`,
          counts: {},
        },
        phrase,
        askPassword: action.reauth,
      };
    }
    if (action.kind === "status") {
      return {
        title: action.to === "blocked" ? `Bloquear a ${action.user.email}` : `Desbloquear a ${action.user.email}`,
        impact: {
          summary:
            action.to === "blocked"
              ? "No podrá iniciar sesión; se cierran todas sus sesiones y se anulan sus tokens de recuperación."
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
          key={`${action!.kind}-${"user" in action! ? action.user.id : action!.op.id}-${"to" in action! ? action.to : ""}`}
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

      {ops.length > 0 && (
        <div data-testid="recovery-ops">
          <h3>Recuperaciones de cuentas de administrador</h3>
          <ul>
            {ops.map((o) => {
              const mine = o.requestedBy === props.me.id;
              const label = labelOf(o.params.userId);
              return (
                <li key={o.id} data-testid={`recovery-op-${o.id}`}>
                  {KIND_TEXT[o.kind]}
                  {label} ·{" "}
                  {o.status === "awaiting_confirmation"
                    ? "pendiente de aprobación"
                    : o.kind === RECOVERY_KIND
                      ? "aprobada: lista para emitir"
                      : "aprobada: lista para aplicar"}{" "}
                  · {mine ? "solicitada por ti" : "solicitada por otro administrador"}{" "}
                  {o.status === "awaiting_confirmation" && !mine && (
                    <Button data-testid={`approve-${o.id}`} onClick={() => setAction({ kind: "approve", op: o })}>
                      Aprobar
                    </Button>
                  )}
                  {o.status === "pending" && mine && (
                    <Button
                      data-testid={`issue-admin-${o.id}`}
                      onClick={() =>
                        setAction(
                          o.kind === RECOVERY_KIND
                            ? { kind: "issueAdmin", op: o, label }
                            : { kind: "applyOp", op: o, label },
                        )
                      }
                    >
                      {o.kind === RECOVERY_KIND ? "Emitir token" : "Aplicar"}
                    </Button>
                  )}{" "}
                  {mine && (
                    <Button
                      variant="link"
                      data-testid={`cancel-op-${o.id}`}
                      onClick={() => setAction({ kind: "cancelOp", op: o })}
                    >
                      Cancelar
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
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
              const isAdmin = u.roles.includes("admin");
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
                                  id: u.id,
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
                            const draft = rolesDraft.roles;
                            const revokes = u.roles.includes("admin") && !draft.includes("admin");
                            const grants = !u.roles.includes("admin") && draft.includes("admin");
                            setAction(
                              revokes && !isMe
                                ? { kind: "requestRevoke", user: u }
                                : { kind: "roles", user: u, roles: draft, reauth: grants || revokes },
                            );
                          }}
                        >
                          Guardar roles
                        </Button>{" "}
                        <Button variant="link" onClick={() => setRolesDraft(null)}>
                          Descartar
                        </Button>
                      </>
                    ) : (
                      <Button
                        data-testid={`roles-edit-${u.id}`}
                        onClick={() => setRolesDraft({ id: u.id, roles: u.roles })}
                      >
                        Roles
                      </Button>
                    )}{" "}
                    {!isMe && (
                      <Button
                        data-testid={`status-${u.id}`}
                        onClick={() =>
                          setAction({ kind: "status", user: u, to: u.status === "blocked" ? "active" : "blocked" })
                        }
                      >
                        {u.status === "blocked" ? "Desbloquear" : "Bloquear"}
                      </Button>
                    )}{" "}
                    {!isMe && u.status === "active" && (
                      <Button
                        data-testid={`recover-${u.id}`}
                        onClick={() =>
                          setAction(isAdmin ? { kind: "requestRecovery", user: u } : { kind: "token", user: u })
                        }
                      >
                        {isAdmin ? "Solicitar recuperación (admin)" : "Token de recuperación"}
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
