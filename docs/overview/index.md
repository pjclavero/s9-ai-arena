# Visión general — índice

## Resumen

Punto de entrada para entender **qué es** S9 AI Arena y **cómo está construido de verdad**, sin
entrar todavía en el código. Si sólo vas a leer un documento, lee [project.md](project.md) y
después [current-status.md](../roadmap/current-status.md).

## Índice

| Documento | Responde a | Léelo si… |
|---|---|---|
| [project.md](project.md) | ¿Qué es, para quién, qué hace y qué no? | llegas nuevo al proyecto |
| [architecture.md](architecture.md) | ¿Qué servicios hay, qué hace cada uno y quién manda sobre cada dato? | vas a tocar código u operar el stack |
| [technologies.md](technologies.md) | ¿Qué tecnologías se usan y en qué versión exacta? | vas a actualizar dependencias o a montar un entorno |
| [glossary.md](glossary.md) | ¿Qué significa *ruleset*, *loadout*, *ticket*, *readiness*…? | encuentras un término que no conoces |

## Orden recomendado

1. [project.md](project.md): idea, usuarios y estado en una línea.
2. [architecture.md](architecture.md): los 12 servicios y, sobre todo, «lo que la arquitectura aparenta y no es».
3. [glossary.md](glossary.md): como consulta.
4. Después, según tu papel:
   - **usuario:** [docs/user/](../user/index.md);
   - **desarrollo:** [docs/technical/](../technical/index.md) y [docs/development/](../development/index.md);
   - **operación:** [docs/operations/](../operations/index.md).

## Regla de esta carpeta

Aquí sólo se describe lo que **existe** en `27f70bb`. Lo diseñado y no implementado está en
[docs/roadmap/pending-features.md](../roadmap/pending-features.md). Lo roto está en
[docs/roadmap/technical-debt.md](../roadmap/technical-debt.md).

## Verificación

| Afirmación | Estado | Fuente |
|---|---|---|
| Cada documento de la carpeta tiene su sección «Verificación» con rutas | CODE_VERIFIED | `docs/overview/*.md` |
