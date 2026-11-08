/**
 * EQ4 · Apartado «Administración»: UNA entrada en la barra principal y una
 * subnavegación con sus pantallas (Usuarios y seguridad, Sistema,
 * Auditoría, Roles y permisos y, EQ5b, Streaming).
 *
 * RBAC: la interfaz sólo OCULTA, la API autoriza (cap. 16). Para que lo que se
 * oculta no se desvíe de lo que el servidor permite, cada pantalla declara las
 * operaciones del contrato que consume (`operations`, operationId de
 * apps/api/openapi.yaml) y el rol mínimo que exige (`minRole`). El test
 * `apps/web/tests/eq4-ux-navegacion.test.tsx` (bloque «RBAC del apartado
 * Administración») comprueba contra el contrato que `minRole` es el
 * máximo de los `x-min-role` de esas operaciones y que `ROLE_ORDER` es la misma
 * jerarquía que usa el servidor (ROLES de apps/api/src/db/migrations.ts). El
 * rango del usuario se calcula igual que en el middleware del servidor: el
 * máximo de los rangos de sus roles (roles desconocidos = 0).
 */
import type { Me } from "./api.js";

/** Jerarquía de roles del servidor, de menor a mayor (ver test de deriva). */
export const ROLE_ORDER = ["visitor", "user", "developer", "team_captain", "organizer", "moderator", "admin"] as const;
export type RoleName = (typeof ROLE_ORDER)[number];

export function roleRank(role: string): number {
  const i = (ROLE_ORDER as readonly string[]).indexOf(role);
  return i < 0 ? 0 : i;
}

/** Rango efectivo de la sesión: el máximo de sus roles (como authenticate.ts). */
export function userRank(me: Pick<Me, "roles"> | null): number {
  if (!me) return 0;
  return Math.max(0, ...me.roles.map(roleRank));
}

export interface AdminSection {
  href: string;
  label: string;
  testId: string;
  /** operationId de las operaciones del contrato que usa la pantalla. */
  operations: string[];
  /** Rol mínimo para usarla = máximo x-min-role de `operations` (test de deriva). */
  minRole: RoleName;
}

export const ADMIN_SECTIONS: readonly AdminSection[] = [
  {
    href: "#/admin",
    label: "Usuarios y seguridad",
    testId: "admin-link",
    operations: ["setUserRoles", "listSecurityFindings", "listAuditLog", "listCatalogVersions"],
    minRole: "admin",
  },
  { href: "#/system", label: "Sistema", testId: "system-link", operations: ["getSystemStatus"], minRole: "admin" },
  { href: "#/audit", label: "Auditoría", testId: "audit-link", operations: ["listAuditLog"], minRole: "admin" },
  { href: "#/roles", label: "Roles y permisos", testId: "roles-link", operations: ["getRbacMatrix"], minRole: "admin" },
  // EQ5b · Administración → Streaming.
  {
    href: "#/streaming",
    label: "Streaming",
    testId: "streaming-link",
    operations: [
      "getStreamingAdmin",
      "updateStreamingSettings",
      "setStreamingCredential",
      "deleteStreamingCredential",
      "getStreamingTarget",
      "testStreaming",
      "startStreaming",
      "restartStreaming",
      "stopStreaming",
      "listStreamingRecordings",
      "applyStreamingRetention",
      "listStreamingAudit",
      "setStreamingIngests",
      "listStreamingDestinations",
    ],
    minRole: "admin",
  },
];

/** Pantallas del apartado que la sesión puede usar según el RBAC del servidor. */
export function visibleAdminSections(me: Pick<Me, "roles"> | null): AdminSection[] {
  const rank = userRank(me);
  return ADMIN_SECTIONS.filter((s) => rank >= roleRank(s.minRole));
}

/** ¿La ruta es una de las pantallas del apartado Administración? */
export function isAdminRoute(route: string): boolean {
  return ADMIN_SECTIONS.some(
    (s) => route === s.href || route.startsWith(`${s.href}/`) || route.startsWith(`${s.href}?`),
  );
}

/**
 * Subnavegación del apartado. Si la sesión no puede usar ninguna pantalla no se
 * pinta (la pantalla dice entonces por qué no tiene permiso).
 */
export function AdminSubnav(props: { me: Me; route: string }) {
  const sections = visibleAdminSections(props.me);
  if (sections.length === 0) return null;
  return (
    <nav aria-label="Administración" className="subnav" data-testid="admin-subnav">
      <span className="subnav-title" aria-hidden="true">
        Administración
      </span>
      {sections.map((s) => {
        const current = props.route === s.href || props.route.startsWith(`${s.href}?`);
        return (
          <a key={s.href} href={s.href} data-testid={`subnav-${s.testId}`} aria-current={current ? "page" : undefined}>
            {s.label}
          </a>
        );
      })}
    </nav>
  );
}
