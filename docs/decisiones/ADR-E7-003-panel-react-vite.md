# ADR-E7-003 — Panel web: React + Vite

- **Estado:** Aceptado
- **Fecha:** 2026-07-16
- **Autor:** E7 · Plataforma Web y API
- **Contexto de tarea:** T7.4 (el dosier exige decidir framework por ADR; sugiere React + Vite)

## Decisión

`apps/web` es una SPA **React 19 + Vite**, servida solo tras el gateway (cap. 6.2), que
consume la API bajo `/api/v1`. El editor de loadouts importa el validador de E3
(`packages/module-catalog/validator`) DIRECTAMENTE: Vite lo compila para navegador, de
modo que cliente y servidor ejecutan literalmente el mismo código de validación (el
cliente solo asiste; la autoridad es el 422 del servidor).

## Justificación

- El visor de E8 es Phaser (ecosistema React/JS); compartir framework evita duplicar
  tooling y permite empotrar el visor en el panel más adelante (razón que da el propio
  dosier al sugerir React).
- El validador de E3 es una función pura sin dependencias de Node: importable tal cual
  en navegador. Con Vue habría dado igual; con React + Vite ya está resuelto en el
  monorepo (vitest usa el mismo pipeline esbuild).
- Sin router externo ni gestor de estado: navegación por hash y `useState` bastan para
  el MVP (registro/login/2FA, bots, editor, subida de código, equipos, administración).

## Verificación en este entorno (honestidad)

Sin navegador ni Playwright disponibles aquí, la DoD "E2E Playwright completo en CI" queda
**pendiente**; se cubre con: tests de componentes (jsdom + Testing Library) del editor
(bloqueo en vivo por presupuesto/masa/energía con el validador real) y de la visibilidad
del panel admin, más el flujo registro→bot→loadout→código→build validado a nivel HTTP
contra la API real (apps/api). El esqueleto Playwright queda para cuando E10 monte el
stack de desarrollo en CI.
