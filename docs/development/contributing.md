# Contribuir

## Resumen

Cómo proponer un cambio a S9 AI Arena: qué debe llevar un pull request, quién lo revisa, qué se
exige para mergear y qué no se acepta. El procedimiento paso a paso está en
[workflow.md](workflow.md); el estilo, en [conventions.md](conventions.md).

## Índice

- [Antes de empezar](#antes-de-empezar)
- [Qué debe llevar un pull request](#qué-debe-llevar-un-pull-request)
- [Revisión y CODEOWNERS](#revisión-y-codeowners)
- [Criterios de merge](#criterios-de-merge)
- [Qué no se acepta](#qué-no-se-acepta)
- [Informar de un problema de seguridad](#informar-de-un-problema-de-seguridad)
- [Documentación relacionada](#documentación-relacionada)
- [Verificación](#verificación)

## Antes de empezar

- Lee el estado real del proyecto y su deuda: [../roadmap/current-status.md](../roadmap/current-status.md),
  [../roadmap/technical-debt.md](../roadmap/technical-debt.md). Si tu cambio resuelve una deuda, cítala
  por su id (`TD-0xx`).
- Prepara el entorno: [setup.md](setup.md).
- Un PR = un objetivo. Cambios grandes se trocean en PR que dejan `main` funcional en cada paso.

## Qué debe llevar un pull request

Título con el formato de commit (`tipo(ámbito): resumen`, ver [conventions.md](conventions.md#commits)).
Cuerpo:

1. **Qué y por qué** (enlace a la deuda o issue).
2. **Base**: commit de `origin/main` del que parte.
3. **Evidencia**: comandos ejecutados y su código de salida real (`typecheck`, `lint`,
   `format:check`, `test:pure`, `test:db`, suites específicas).
4. **Controles negativos**: qué se rompió a propósito y cómo se puso rojo el test; mutantes
   ejecutados y supervivientes (deben ser 0).
5. **Documentación**: documentos canónicos tocados y su `## Verificación`.
6. **Riesgos**: migraciones, cambios de contrato, efectos en despliegue, deuda que queda.

## Revisión y CODEOWNERS

`.github/CODEOWNERS` asigna revisión obligatoria (rol E6, seguridad/sandbox) a motor, protocolo,
sandbox y runtimes. Hoy el propietario del repositorio actúa como revisor de esas rutas. CODEOWNERS
sólo bloquea si la protección de rama de `main` exige revisión de code owners (configuración del
repositorio, fuera del código).

El revisor comprueba: que los tests prueban comportamiento (no texto), que existe control negativo,
que la documentación no afirma nada no verificado y que no hay topología ni secretos.

## Criterios de merge

- CI con **todas** las conclusiones en `success` (`gh pr checks`); `skipped`/`neutral` requieren
  explicación explícita y no cuentan como verde ([ci.md](ci.md#cómo-leer-la-ci)).
- Review aprobada.
- Rama actualizada con `main` sin conflictos; si es un PR apilado, reapuntado antes de borrar ramas.

## Qué no se acepta

- Secretos, IPs, nombres de host o usuarios reales, emails, en cualquier fichero (repositorio
  **público**).
- Tests que sólo comprueban que un texto aparece cuando lo que importa es un efecto.
- Activar por defecto puertas de seguridad (`S9_ENABLE_REAL_BATTLE_RUNS`, espectador o replays
  públicos) sin cerrar sus condiciones ([../technical/security.md](../technical/security.md)).
- `seed` o usuarios con contraseña conocida en caminos de producción.
- Etiquetas `latest` o `--profile nucleo` en comandos de despliegue.

## Informar de un problema de seguridad

No abras un issue público con detalles explotables. Contacta con el propietario del repositorio
por un canal privado y aporta pasos de reproducción en un entorno aislado.

## Documentación relacionada

[workflow.md](workflow.md) · [conventions.md](conventions.md) · [ci.md](ci.md) · [testing.md](testing.md) ·
[contract-compatibility.md](contract-compatibility.md).

## Verificación

| Afirmación | Estado | Evidencia |
|---|---|---|
| CODEOWNERS y su nota sobre la protección de rama | CODE_VERIFIED | `.github/CODEOWNERS` (cabecera) |
| Regla de conclusiones de CI | CODE_VERIFIED | ADR-017 §10; `infrastructure/scripts/ci-gate.mjs` |
| Puertas apagadas por defecto | CODE_VERIFIED | `apps/api/src/battle-run.ts:86`; `public-spectate.ts:10-12`; `public-replays.ts:18-20` |
