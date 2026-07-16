import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    // Mismo alias que consumer-typecheck-example/tsconfig.json (paths): permite que
    // los bots de ejemplo y sus tests importen "@arena/sdk" como lo haría un
    // consumidor externo real, en vez de una ruta relativa a sdks/javascript/src.
    alias: {
      "@arena/sdk": fileURLToPath(new URL("./sdks/javascript/src/index.ts", import.meta.url)),
    },
  },
  // JSX del panel web de E7 (apps/web): runtime automático de React.
  esbuild: { jsx: "automatic" },
  test: {
    include: [
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
      "packages/**/*.test.ts",
      "sdks/**/*.test.ts",
      "example-bots/**/*.test.ts",
      "infrastructure/**/*.test.ts",
      // E12 · QA transversal: suite E2E del MVP (T12.1), jobs de aceptación
      // propios (T12.2) y game days ejecutables (T12.3).
      "tests/e2e/**/*.test.ts",
      "tests/acceptance/**/*.test.ts",
      "tests/gamedays/**/*.test.ts",
    ],
    testTimeout: 180000,
    hookTimeout: 60000,
  },
});
