# ADR: Retención y archivado de `audit_log`

- **Estado:** propuesto (diseño, sin implementar)
- **Fecha:** 2026-08-09
- **Autor:** equipo AUDIT_LOG (agente, autorizado por el operador)
- **Rama:** `design/audit-log-retencion`

## 1. Contexto y problema

`audit_log` registra acciones administrativas, de publicación y eventos de
seguridad de la API (`apps/api/src/audit.ts`, tabla creada en
`apps/api/src/db/migrations.ts:427-444`). La tabla no tiene `UPDATE` ni
`DELETE` posibles: un trigger `BEFORE UPDATE OR DELETE` lanza excepción
(`apps/api/src/db/migrations.ts:436-444`):

```sql
CREATE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
```

Respaldado por test (`apps/api/src/db/schema.test.ts:160-166`):

```
it("audit_log es de solo inserción: UPDATE y DELETE fallan", async () => {
  const [row] = await h.db("audit_log").insert({ action: "test.append_only", target: "audit_log" }).returning("*");
  await expect(h.db("audit_log").where({ id: row.id }).update({ action: "tamper" })).rejects.toThrow(
    /solo inserción/,
  );
  await expect(h.db("audit_log").where({ id: row.id }).delete()).rejects.toThrow(/solo inserción/);
});
```

Esto significa que la tabla **crece sin límite por diseño**: es la garantía
deliberada de que ningún registro de auditoría puede alterarse ni
desaparecer, ni siquiera por un administrador con acceso a la BD (salvo
`DROP`/`TRUNCATE` a nivel de superusuario, fuera del alcance de la app).

Con el tiempo esto plantea una pregunta operativa legítima: ¿cuánto crece la
tabla, a partir de qué tamaño empieza a doler (consultas, backups, disco), y
qué hacer al respecto **sin romper la garantía de inmutabilidad**.

## 2. Decisión ya tomada por el operador (no se reabre aquí)

**No se purga ni se borra nunca `audit_log`.** La vía para controlar su
tamaño, si algún día hace falta, es **archivado inmutable o particionado**,
nunca `DELETE`. Este ADR no propone ni evalúa el borrado como opción; lo
descarta explícitamente (ver §7).

## 3. Puntos de inserción (inventario completo, por grep)

Toda inserción pasa por una única función, `audit()`
(`apps/api/src/audit.ts:12-20`):

```ts
export async function audit(db: Db, e: AuditEvent): Promise<void> {
  await db("audit_log").insert({
    actor_id: e.actorId ?? null,
    action: e.action,
    target: e.target,
    detail: JSON.stringify(e.detail ?? {}),
    correlation_id: e.correlationId ?? null,
  });
}
```

Búsqueda de todos los llamadores (`grep -rn "audit(" apps/api/src --include=*.ts | grep -v ".test.ts" | grep -v "audit.ts:"`):

| # | Archivo:línea | Acción (`action`) | Disparador |
|---|---|---|---|
| 1 | `routes/teams.ts:55` | `team.created` | Crear un equipo |
| 2 | `routes/users.ts:56` | `admin.user.roles_set` | Admin cambia roles de un usuario |
| 3 | `services/bot-manager.ts:119` | `bot.version.validated` / `bot.version.rejected` | Build de un bot pasa/falla validación |
| 4 | `services/bots.ts:112` | `bot.version.<transición de estado>` | Cambio de estado de una versión de bot (publicar, etc.) |
| 5 | `routes/maps.ts:185` | `map.draft_saved` | Guardar borrador de mapa |
| 6 | `routes/maps.ts:230` | `map.published` | Publicar mapa |
| 7 | `routes/tournaments.ts:115` | `tournament.created` | Crear torneo |
| 8 | `routes/tournaments.ts:265` | `tournament.entries_closed` | Cerrar inscripciones de torneo |
| 9 | `routes/catalog.ts:30` | `admin.catalog.imported` | Admin importa catálogo |
| 10 | `routes/auth.ts:200` | `auth.login.blocked` | Login bloqueado por fuerza bruta (anomalía) |
| 11 | `routes/auth.ts:253` | `auth.refresh.reuse_detected` | Reutilización de refresh token detectada (anomalía de seguridad) |
| 12 | `routes/auth.ts:330` | `auth.session.revoked_by_admin` | Admin revoca sesión de otro usuario |
| 13 | `routes/auth.ts:352` | `auth.2fa.enabled` | Usuario activa 2FA |
| 14 | `routes/auth.ts:373` | `auth.2fa.disabled` | Usuario desactiva 2FA |
| 15 | `routes/auth.ts:426` | `auth.password.reset` | Reset de contraseña completado |

**Hallazgo relevante para la estimación:** el login normal (con éxito) **no**
se audita — sólo las anomalías (`auth.login.blocked`,
`auth.refresh.reuse_detected`) y los cambios administrativos/de seguridad
(2FA, reset de contraseña, revocación de sesión). Es decir, el tráfico normal
de la API (jugar partidas, ver rankings, subir bots que no fallan validación)
no escribe en `audit_log` salvo en los puntos 3-9 de la tabla. Esto reduce
mucho el volumen frente a "un log por request".

No hay un `TRUNCATE`, `COPY`, ni ningún otro punto de escritura a
`audit_log` en el código (confirmado por el mismo grep: sólo aparecen
`audit.ts` como definición, `admin.ts:28` como lectura, y los 15 sitios de la
tabla como escritura).

## 4. Tamaño de fila (derivado del esquema, no medido)

Columnas (`apps/api/src/db/migrations.ts:427-434`):

```
id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY
actor_id       uuid REFERENCES users(id) ON DELETE SET NULL
action         text NOT NULL
target         text NOT NULL
detail         jsonb NOT NULL DEFAULT '{}'
correlation_id text
at             timestamptz NOT NULL DEFAULT now()
```

Con los `detail`/`action`/`target` reales observados en el inventario del
§3 (p.ej. `action: "auth.refresh.reuse_detected"` de 28 caracteres,
`target: "tournament:<uuid>"` de ~47 caracteres con un UUID de 36
caracteres, `detail: { ip, reason: "rotated_token_replayed", family }` de
unos 70-90 bytes en JSON), y aplicando el modelo de almacenamiento estándar
de PostgreSQL (cabecera de tupla ~23 bytes + puntero de línea ~4 bytes +
bitmap de nulos + relleno a múltiplos de 8 bytes — MAXALIGN):

- overhead de fila: ~27-28 bytes
- `id` (bigint): 8 bytes
- `actor_id` (uuid, ~12/15 sitios lo rellenan; 2 anomalías de pre-auth lo dejan `null`): 16 bytes cuando presente
- `action` (texto corto, 12-30 caracteres observados): ~16-34 bytes con cabecera varlena
- `target` (incluye normalmente un UUID de 36 caracteres + prefijo): ~40-55 bytes
- `detail` (jsonb; desde `'{}'` de 2 bytes hasta objetos con 2-4 claves, ~40-90 bytes observados en el inventario): ~10-90 bytes, media estimada ~50 bytes
- `correlation_id` (UUID string cuando presente — confirmado en `apps/api/src/middleware/context.ts:16`, `req.correlationId = randomUUID()`): ~40 bytes cuando presente, casi siempre presente (13/15 sitios lo pasan)
- `at` (timestamptz): 8 bytes

**Estimación de fila: ≈200-260 bytes de datos** (heap), redondeando a
alineación de 8 bytes. Añadiendo el índice del `PRIMARY KEY` sobre `id`
(bigint en btree, ~16 bytes/entrada) da un **footprint total en disco de
≈220-280 bytes/fila**. Esto es una **estimación derivada del esquema y de
los literales de `action`/`target`/`detail` vistos en el código**, no una
medición: PostgreSQL puede añadir compresión TOAST si algún `detail` crece
más allá de ~2 KB (ninguno de los observados se acerca a ese umbral), y el
`fillfactor`/fragmentación reales dependen de la instancia.

## 5. Estimación de crecimiento (derivada del código, con asunciones explícitas)

**Esto es una estimación, no una medición.** No hay acceso a la base de
datos de producción y no se ha intentado obtenerlo, tal como exige la
consigna. Las asunciones se listan una a una para que puedan cuestionarse o
sustituirse por datos reales.

Asunciones sobre el uso (homelab de "un puñado de usuarios", según la
memoria del proyecto):

- **Usuarios activos:** 5-15 personas (asunción; no hay un contador de
  usuarios en el código que se haya inspeccionado para este ADR).
- **Torneos:** quizá 1-4 al mes en fase activa de uso (asunción; genera 2
  filas por torneo: `tournament.created` + `tournament.entries_closed`).
- **Mapas:** publicar/editar mapas es una actividad de diseño, no de
  partida a partida; asumo 5-20 guardados/publicaciones al mes en conjunto
  (asunción).
- **Bots:** cada subida de una nueva versión de bot genera 1 fila
  (`bot.version.validated`/`rejected`) más, si se publica, otra fila de
  transición de estado (`services/bots.ts`). Asumo 10-40 subidas/mes entre
  todos los usuarios en fase activa (asunción, sin datos de telemetría de
  subidas revisados).
- **Auth:** los eventos auditados son anomalías o cambios de seguridad, no
  el login normal. Asumo que la fuerza bruta y la reutilización de tokens
  son raras (0-5 eventos/mes) y que 2FA/reset de contraseña son eventos
  puntuales por usuario, no recurrentes (quizá 1-3 eventos/mes en total).
- **Catálogo:** `admin.catalog.imported` es una operación de administrador,
  no recurrente en el uso normal; asumo 0-2 veces al mes.
- **Roles de usuario:** `admin.user.roles_set` es de administración pura;
  asumo 0-2 veces al mes.
- **Equipos:** `team.created` depende de cuántos equipos nuevos se crean;
  asumo 1-5 al mes en fase activa, cercano a 0 en fase estable (los equipos,
  una vez creados, no vuelven a auditarse en el código inspeccionado).

Con estas asunciones, el total de filas/mes en fase de uso activo se sitúa
en un rango de **~20 a ~100 filas/mes** (suma de los rangos anteriores).

Con el tamaño de fila de la §4 (≈220-280 bytes con índice):

- **Rango bajo:** 20 filas/mes × 220 bytes ≈ 4.4 KB/mes ≈ **~53 KB/año**
- **Rango alto:** 100 filas/mes × 280 bytes ≈ 28 KB/mes ≈ **~336 KB/año**

Es decir, con estas asunciones, `audit_log` crecería del orden de **decenas
a cientos de kilobytes al año**, no megabytes ni gigabytes, en un homelab de
este tamaño. Incluso proyectando 10 años de uso continuo al ritmo alto, el
total rondaría **~3-4 MB** — órdenes de magnitud por debajo de donde el
tamaño de una tabla empieza a ser un problema operativo en PostgreSQL.

**Esto NO cubre**: picos de uso muy por encima de estas asunciones (p.ej. un
ataque de fuerza bruta sostenido generando muchos `auth.login.blocked`, o un
CI/bot malicioso generando cientos de `bot.version.rejected`), ni un cambio
de producto que audite más eventos en el futuro (p.ej. auditar también el
login normal). Si cualquiera de esas asunciones cambia en un orden de
magnitud, el rango de arriba cambia en la misma proporción.

## 6. Procedimiento de medición real (para que el operador lo ejecute)

Estas consultas no se han ejecutado contra producción; se proponen para que
el operador las corra cuando quiera reemplazar la estimación del §5 por
datos reales.

**a) Tamaño físico actual de la tabla (heap + índices + TOAST):**

```sql
SELECT pg_size_pretty(pg_total_relation_size('audit_log')) AS tamano_total,
       pg_size_pretty(pg_relation_size('audit_log'))       AS tamano_heap,
       pg_size_pretty(pg_indexes_size('audit_log'))        AS tamano_indices;
```

**b) Recuento de filas y tamaño medio real por fila:**

```sql
SELECT count(*) AS filas,
       pg_size_pretty(pg_total_relation_size('audit_log') / GREATEST(count(*), 1)) AS bytes_por_fila
FROM audit_log;
```

**c) Distribución de filas por mes (para ver la tasa de crecimiento real y compararla con la estimación del §5):**

```sql
SELECT date_trunc('month', at) AS mes, count(*) AS filas
FROM audit_log
GROUP BY 1
ORDER BY 1;
```

**d) Distribución por tipo de acción (para ver qué eventos dominan el volumen, y contrastar con la tabla del §3):**

```sql
SELECT action, count(*) AS filas
FROM audit_log
GROUP BY 1
ORDER BY 2 DESC;
```

**e) Tasa de crecimiento entre dos snapshots (ejecutar (a) hoy, repetir dentro de N días/semanas):**

```sql
-- snapshot 1 (hoy)
SELECT now() AS ts, pg_total_relation_size('audit_log') AS bytes;
-- snapshot 2 (dentro de, p.ej., 30 días): repetir la misma consulta y
-- calcular (bytes_2 - bytes_1) / dias_transcurridos = bytes/día reales.
```

**f) Tamaño medio de la columna `detail` (para verificar si TOAST está actuando y si el jsonb es más pesado de lo asumido en el §4):**

```sql
SELECT avg(pg_column_size(detail)) AS bytes_detail_medio,
       max(pg_column_size(detail)) AS bytes_detail_max
FROM audit_log;
```

Con (a)+(b)+(c) el operador tiene, en pocos minutos, el dato que este ADR
sólo puede estimar: filas reales, bytes reales por fila, y tendencia mensual
real.

## 7. `DELETE` y purga: descartados

Por decisión explícita del operador, **no se contempla ningún mecanismo que
borre filas de `audit_log`**: ni una purga programada, ni un `DELETE` manual,
ni un `TRUNCATE`. El trigger `audit_log_append_only` (§1) ya lo impide a
nivel de base de datos para `UPDATE`/`DELETE` vía la aplicación; cualquier
propuesta futura de reducción de tamaño **debe preservar esa inmutabilidad**
y limitarse a mover datos a almacenamiento igualmente append-only (archivo),
nunca a eliminarlos.

## 8. Requisitos legales/operativos de retención

**No se ha encontrado ningún requisito de retención documentado en el
repositorio.** La búsqueda (`grep -rli "retenci\|retention\|GDPR\|RGPD\|compliance" apps/api docs`)
sólo encontró menciones de "retención" en:

- `docs/decisiones/ADR-010-devops-ci-observabilidad-backup.md` (líneas 46-50): retención de *backups* de la BD completa con `restic`, no de `audit_log` específicamente ni de un plazo legal — es retención operativa de copias de seguridad.
- Otros documentos (`docs/estado-proyecto.md`, `docs/streaming-runbook.md`, etc.) que no fijan un plazo de retención para `audit_log`.

Este proyecto es un homelab personal sin indicios en el repositorio de estar
sujeto a un régimen regulatorio (RGPD, HIPAA, SOX, etc.) que exija una
retención mínima o máxima de logs de auditoría. **No se inventa aquí ningún
plazo legal.** Si el operador tiene un requisito real (por ejemplo, por
alojar datos de terceros o por una política externa), debe añadirse a este
ADR como entrada explícita antes de fijar umbrales de archivado basados en
"cuándo se puede archivar" en vez de sólo "cuándo conviene archivar por
tamaño".

## 9. Umbrales de actuación (cuantificados)

Dado que la estimación del §5 sitúa el crecimiento en kilobytes/año, estos
umbrales son deliberadamente altos — no hay urgencia con los datos actuales.
Se proponen como disparadores objetivos para revisar esta decisión, no como
una alarma inminente:

| Umbral | Acción disparada |
|---|---|
| `pg_total_relation_size('audit_log')` > **50 MB** | Ejecutar el procedimiento de medición del §6 y comparar con la estimación de este ADR; si el crecimiento real excede al asumido en más de 10x, revisar las asunciones del §5. |
| `pg_total_relation_size('audit_log')` > **500 MB** | Empezar a implementar archivado (opción recomendada del §10) antes de que afecte a backups o a la consulta `listAuditLog`. |
| Filas/mes reales (consulta (c) del §6) > **10x** el rango alto del §5 (>1000 filas/mes sostenidas) | Revisar si se ha añadido auditoría de eventos de alto volumen (p.ej. login normal) sin revisar el impacto en tamaño; considerar adelantar el archivado aunque el tamaño absoluto aún sea bajo. |
| Tiempo de `pg_dump` del backup completo (ADR-010) aumenta de forma perceptible atribuible a `audit_log` | Revisar si conviene excluir `audit_log` del `pg_dump` normal y respaldarla aparte (ver §10). |
| La consulta `listAuditLog` (`apps/api/src/routes/admin.ts:26-39`, `ORDER BY id DESC LIMIT <=100`) empieza a tardar de forma perceptible | Con el índice del `PRIMARY KEY` sobre `id` esto no debería depender del tamaño de la tabla (es un index scan acotado), pero conviene confirmarlo con `EXPLAIN ANALYZE` antes de asumir que el archivado lo arregla. |

Estos números son **umbrales de ingeniería propuestos**, no medidos ni
derivados de un límite duro de PostgreSQL; PostgreSQL maneja sin problema
tablas de muchos GB. El motivo de fijarlos bajos es operativo: son un buen
punto para revisar la estimación con datos reales antes de que la tabla
llegue a un tamaño que sí importe.

## 10. Opciones de archivado compatibles con append-only

Todas las opciones **preservan la inmutabilidad**: ninguna borra una fila
sin haberla copiado antes a un destino igualmente inmutable, y ninguna
modifica filas existentes.

### Opción A — Particionado por rango de fechas con `pg_partman`

Convertir `audit_log` en una tabla particionada por `at` (mensual o
trimestral) usando la extensión `pg_partman`, que automatiza la creación de
particiones nuevas y puede mover particiones antiguas a un tablespace más
barato o desprenderlas (`detach`) hacia una tabla de archivo separada (nunca
`DROP` directo sin antes desprender y conservar).

- **A favor:** automatizado, es el patrón estándar de PostgreSQL para tablas append-only que crecen; las particiones "frías" pueden vivir en un tablespace distinto sin tocar la lógica de la app (las vistas/consultas siguen viendo `audit_log` como una tabla); permite excluir particiones antiguas del `pg_dump` normal y respaldarlas una sola vez.
- **En contra:** añade una dependencia nueva (extensión `pg_partman`, no confirmada como disponible en la imagen `postgres:16-alpine` usada — **requiere verificación**: la imagen alpine oficial no trae extensiones de terceros preinstaladas, habría que construir una imagen propia o usar `postgres:16` con `pg_partman` instalado manualmente); la migración de una tabla no particionada a particionada requiere una migración con ventana de mantenimiento (crear tabla particionada nueva, copiar filas, renombrar) — no es un `ALTER TABLE` trivial en PostgreSQL 16; el trigger `audit_log_append_only` (§1) tendría que replicarse en cada partición o convertirse en una regla a nivel de tabla padre (los triggers `BEFORE UPDATE/DELETE` en PostgreSQL particionado se heredan si se definen en la tabla padre desde PG 11+, así que esto es viable pero hay que probarlo).
- **Impacto en backups:** positivo a largo plazo (particiones frías se respaldan una vez y no vuelven a cambiar), pero añade complejidad al `pg_dump`/`restic` actual (ADR-010), que hoy trata la BD como un bloque.
- **Impacto en consultas:** `listAuditLog` sigue funcionando igual (particionado por rango con `ORDER BY id DESC LIMIT n` puede necesitar un índice global o tocar sólo la partición más reciente, hay que revisar el plan de consulta).

### Opción B — Tabla de archivo manual (`audit_log_archive`)

Un job periódico (o manual) copia con `INSERT ... SELECT` las filas más
antiguas que un umbral de fecha a una tabla `audit_log_archive` (mismo
esquema, sin trigger de inmutabilidad porque nunca se actualiza tampoco, o
con el mismo trigger por coherencia), y **desprende** (no borra) esas filas
de `audit_log` sólo tras confirmar la copia — lo cual, dado que `DELETE` está
bloqueado por el propio trigger, requeriría o bien deshabilitar
temporalmente el trigger para esa operación administrativa concreta (con
autorización explícita, fuera del flujo normal de la app) o bien no
desprenderlas nunca y dejar que `audit_log_archive` sea sólo una copia de
lectura rápida para consultas históricas, mientras `audit_log` sigue
creciendo sin límite como hoy.

- **A favor:** no añade dependencias nuevas (SQL puro, ningún `pg_partman`); fácil de entender y de auditar el propio job de archivado; puede implementarse como un script simple ejecutado por cron o por el propio operador.
- **En contra:** si de verdad se quiere reducir el tamaño de `audit_log` (no sólo tener una copia), hay que desactivar el trigger append-only para el `DELETE` del archivado — esto es un punto delicado porque abre, aunque sea momentáneamente y bajo control, la posibilidad técnica de alterar la tabla íntegra. Esto **contradice el espíritu** de la garantía actual y debería evitarse o, como mínimo, requerir aprobación explícita cada vez, nunca automatizarse sin supervisión. Es la opción con más fricción respecto a la decisión del operador.
- **Impacto en backups:** neutro; ambas tablas se respaldan igual que hoy.
- **Impacto en consultas:** `listAuditLog` seguiría leyendo sólo `audit_log`; si se quiere ver histórico habría que unir ambas tablas o cambiar la consulta.

### Opción C — Export periódico a almacenamiento inmutable (WORM)

Un job exporta (p.ej. `COPY ... TO` en formato CSV/JSONL, o `pg_dump --table=audit_log`) un snapshot periódico de `audit_log` completa o incremental (por rango de `at`) a almacenamiento fuera de la BD — por ejemplo, el mismo repositorio `restic` que ya usa el backup de la BD (ADR-010), o un bucket/objeto con política de retención WORM (write-once-read-many) si el operador dispone de uno.

- **A favor:** no requiere tocar el esquema de `audit_log` ni el trigger existente en absoluto; reutiliza la infraestructura de backup que ya existe (`restic`, ADR-010); el archivo exportado es, por construcción, tan inmutable como el medio de almacenamiento lo permita (p.ej. `restic` con `--exclude-larger-than` no aplica aquí, pero sus snapshots son inmutables por diseño); no reduce el tamaño de la tabla en PostgreSQL, sólo da una copia externa duradera.
- **En contra:** si el objetivo es reducir el tamaño de la tabla en el propio PostgreSQL (por ejemplo, para acelerar el `pg_dump` diario), esta opción por sí sola no lo consigue — sólo añade una copia, la tabla origen sigue creciendo igual. Combinar esto con la Opción A o B sería necesario si el tamaño real algún día supera los umbrales del §9.
- **Impacto en backups:** es, en la práctica, una extensión del backup ya existente (ADR-010) — bajo esfuerzo de implementación.
- **Impacto en consultas:** ninguno; `audit_log` no cambia.

### Comparación honesta

| | A: Particionado (`pg_partman`) | B: Tabla de archivo manual | C: Export a almacenamiento inmutable |
|---|---|---|---|
| Reduce tamaño de la tabla activa | Sí (particiones frías, con tablespace o detach) | Sólo si se desprenden filas (fricción con el trigger) | No, sólo añade copia externa |
| Nuevas dependencias | Sí (`pg_partman`, no confirmado en la imagen actual) | No | No (reutiliza `restic`) |
| Riesgo de tocar la garantía append-only | Bajo (con detach + conservación) | Medio-alto (requiere desactivar el trigger para el `DELETE`) | Ninguno |
| Esfuerzo de implementación | Alto (migración de esquema, ventana de mantenimiento) | Medio | Bajo |
| Urgencia dado el §5 | Ninguna a corto plazo | Ninguna a corto plazo | Ninguna a corto plazo |

### Recomendación

Con el crecimiento estimado en el §5 (decenas/cientos de KB al año), **no
hay urgencia real para implementar ninguna de las tres ahora**. Cuando se
cruce alguno de los umbrales del §9:

1. **Empezar por la Opción C** (export periódico a `restic`, reutilizando ADR-010): es la de menor riesgo y menor esfuerzo, no toca el esquema ni el trigger, y da una copia duradera inmediatamente.
2. **Si el tamaño de la tabla activa en sí se vuelve un problema** (backups lentos, `listAuditLog` degradado — poco probable dado el índice sobre `id`, pero a verificar con `EXPLAIN ANALYZE` en su momento), migrar a la **Opción A** (particionado con `pg_partman`), planificando la migración de esquema con ventana de mantenimiento y verificando primero que el trigger de inmutabilidad se hereda correctamente en las particiones.
3. **Evitar la Opción B** salvo necesidad concreta: es la única que requiere tocar, aunque sea puntualmente, la protección `UPDATE/DELETE`, lo cual va contra el espíritu de la decisión del operador.

## 11. Qué queda descartado explícitamente

- **`DELETE` o `TRUNCATE` sobre `audit_log`, en cualquier forma automatizada.** No se propone, no se diseña, no se deja como opción "por si acaso".
- **Cualquier cambio al trigger `audit_log_append_only`** que lo debilite (por ejemplo, permitir `DELETE` bajo alguna condición) sin aprobación explícita del operador, caso por caso.
- **Fijar un plazo de retención legal inventado.** No se ha encontrado ninguno documentado (§8); no se rellena con un número inventado.

## 12. Pendiente / siguiente paso

- Ejecutar el procedimiento de medición del §6 contra producción (lo debe hacer el operador o un agente con permiso explícito de solo lectura sobre la BD de producción — este ADR y el agente que lo escribió no tienen ni piden ese acceso).
- Si el operador identifica un requisito de retención real (regulatorio o contractual), añadirlo al §8 y revisar si cambia algún umbral del §9.
- Confirmar disponibilidad de `pg_partman` en la imagen `postgres:16-alpine` actual (`infrastructure/docker-compose.yml:494`) antes de comprometerse con la Opción A, o decidir migrar a una imagen con la extensión instalada.
