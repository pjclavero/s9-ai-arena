/**
 * R2.3 (ERR-GES-04) · Suite "pura": todo lo que NO necesita PostgreSQL.
 *
 * Misma configuración base que `npm test`, excluyendo los ficheros que usan
 * `startTestDb` (embedded-postgres/pg_ctl, que no funciona en Windows).
 * Ejecutar con `npm run test:pure`. Los tests de BD van en `npm run test:db`.
 */
import { configDefaults } from "vitest/config";
import base from "./vitest.config";
import { listDbTests } from "./scripts/list-db-tests.mjs";

export default {
  ...base,
  test: {
    ...base.test,
    exclude: [...configDefaults.exclude, ...listDbTests()],
  },
};
