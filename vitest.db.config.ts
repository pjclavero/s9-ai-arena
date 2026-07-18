/**
 * R2.3 (ERR-GES-04) · Suite de BD: solo los tests que exigen PostgreSQL.
 *
 * Ejecutar con `npm run test:db`. Por defecto arrancan embedded-postgres
 * (Linux/macOS); en Windows, o donde pg_ctl embebido no funcione, define
 * DATABASE_URL apuntando a un PostgreSQL real (contenedor o servicio local)
 * y los tests crearán bases de datos efímeras en ese servidor.
 * Ver docs/getting-started.md.
 */
import base from "./vitest.config";
import { listDbTests } from "./scripts/list-db-tests.mjs";

const dbTests = listDbTests();
if (dbTests.length === 0) {
  // Falla cerrado (regla Ronda 2): una suite de BD vacía sería un verde vacuo.
  throw new Error(
    "vitest.db.config.ts: el escaneo no encontró ningún test con startTestDb; " +
      "revisa scripts/list-db-tests.mjs antes de dar la suite por buena.",
  );
}

export default {
  ...base,
  test: {
    ...base.test,
    include: dbTests,
  },
};
