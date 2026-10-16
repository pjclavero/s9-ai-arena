# Convenciones

## Resumen

Convenciones de idioma, commits, código y documentación del proyecto. La plantilla de
documentación es la común de la consolidación de 2026-10; la siguen todos los documentos vigentes
de `docs/`.

## Índice

- [Idioma](#idioma)
- [Commits](#commits)
- [Código](#código)
- [Documentación](#documentación)
- [Seguridad documental](#seguridad-documental)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Idioma

Español en documentación, mensajes de commit, comentarios y mensajes de error orientados al
operador. Identificadores de código, nombres de ficheros técnicos y contratos (`openapi.yaml`,
protocolo) en inglés salvo que ya existan en español.

## Commits

Formato observado en el historial: `tipo(ámbito): resumen en español`, en imperativo o descriptivo,
sin punto final.

| Tipo | Uso |
|---|---|
| `feat` | funcionalidad nueva |
| `fix` | corrección |
| `test` | sólo tests |
| `docs` | sólo documentación |
| `infra` / `chore(infra)` | compose, Dockerfiles, scripts de operación |
| `chore` | mantenimiento, dependencias (`fix(deps)` si corrige vulnerabilidades) |

Ámbitos frecuentes: `api`, `engine`, `tournament-worker`, `web`, `infra`, `deps`, `ops`, `restore`.
Los merges de PR quedan como `Merge PR #<n>: <resumen>`. El cuerpo explica el porqué y la evidencia;
los co-autores van como trailer `Co-Authored-By:`.

## Código

- TypeScript ESM ejecutado con `tsx`; imports relativos con extensión `.js`/`.ts`.
- Formato: Prettier (`.prettierrc.json`); `npm run format:check` en CI.
- Determinismo: `apps/arena-engine/src/sim/` sin reloj de pared ni E/S (`npm run lint`).
- **Fail-closed**: sin secreto, sin configuración o con un valor inválido, el servicio no arranca o
  la puerta queda cerrada; nunca un valor por defecto inseguro.
- Accesos por clave dinámica con `safeLookup` (`packages/game-rules`) para evitar
  `__proto__`/prototipos.
- Secretos sólo por fichero (`*_FILE`); nunca en argumentos de línea de comandos ni en logs.
- Logs JSON con `correlation_id`.
- Migraciones nuevas, nunca editar las publicadas.

## Documentación

Plantilla general (no forzar secciones vacías):

```
# Título
## Resumen
## Índice
## Qué es
## Cómo funciona
## Uso
## Ejemplo
## Errores / limitaciones
## Estado actual
## Documentación relacionada
## Verificación
```

Los técnicos añaden según aplique: `## Arquitectura`, `## Componentes`, `## Flujo de datos`,
`## Contratos`, `## Persistencia`, `## Configuración`, `## Seguridad`, `## Tests`, `## Extensión`.

Reglas:

- **Un documento canónico por tema**; los demás enlazan. Enlaces relativos y en los dos sentidos
  (usuario ↔ técnico ↔ operación).
- Estado en docs funcionales: **FUNCIONA ACTUALMENTE / PARCIAL / PENDIENTE**; la deuda se enlaza a
  `docs/roadmap/technical-debt.md#td-0xx`.
- Todo documento canónico termina con `## Verificación`: tabla afirmación → `CODE_VERIFIED` /
  `RUNTIME_VERIFIED` / `DESIGN_ONLY` con `ruta:línea` o comando. Lo `DESIGN_ONLY` nunca se redacta
  como comportamiento existente.
- Comandos peligrosos en un bloque con **DANGER / PRECONDITION / EFFECT / ROLLBACK**.
- Prohibido en comandos: `latest`, perfil `nucleo`, nombres antiguos de volumen o proyecto
  (`s9-ai-arena_*`), `seed` en producción, comandos no contrastados con el código.
- Lo histórico vive en `docs/history/`, `docs/testing/`, `docs/audits/anteriores/` y no se actualiza
  como si fuera vigente ([../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md)).

## Seguridad documental

El repositorio es **público**. Nunca escribir IPs reales (LAN, Tailscale, WAN), identificadores de
máquinas virtuales, nombres de hipervisor u hosts internos, usuarios de sistema reales, rutas de
secretos reales, tokens, contraseñas ni emails. Usar `192.0.2.x`, `198.51.100.x`, `203.0.113.x`,
`<host-arena>`, `<backup-host>`, `example.internal`, `<operador>`. Lo que necesite datos reales de una
instalación va al repositorio privado de infraestructura del operador, no aquí.

## Documentación relacionada

[contributing.md](contributing.md) · [workflow.md](workflow.md) · [../README.md](../README.md) ·
[../DOC-MIGRATION-MAP.md](../DOC-MIGRATION-MAP.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| Formato de commits | CODE_VERIFIED | `git log --format=%s` de los últimos 40 commits de `main` |
| Prettier, lint de determinismo | CODE_VERIFIED | `package.json`; `.prettierrc.json` |
| `safeLookup` en `packages/game-rules` | CODE_VERIFIED | `packages/game-rules/safe-lookup.ts` |
| Secretos por `*_FILE` y fail-closed | CODE_VERIFIED | `apps/api/src/auth/tokens.ts:74-80`; `apps/api/src/db/connection.ts:30-35` |
