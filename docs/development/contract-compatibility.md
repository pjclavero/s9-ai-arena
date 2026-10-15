# Compatibilidad y proceso de cambio de contratos

Mantenido por **E1**. Cubre la mejora E1.M del dosier de tareas: el dosier técnico exige contratos versionados pero no define ni la política de versionado ni el proceso de cambio.

## 1. Qué es un contrato

Son contratos, y solo ellos, los artefactos de estos cuatro paquetes:

| Paquete | Contenido | Consumidores |
|---|---|---|
| `@arena/protocol` | Envelope y los 6 mensajes de `arena/1` | motor (E2), SDKs (E5), bots |
| `@arena/module-catalog` (schema) | Definición de módulo y de loadout | motor (E2), catálogo (E3), API (E7), editor web |
| `@arena/map-schema` | Formato interno de mapa | map-service (E4), motor (E2), API (E7) |
| `apps/api/openapi.yaml` | API HTTP de la plataforma | web (E7), workers (E9), clientes externos |

Todo lo demás es implementación y puede cambiar libremente dentro de su equipo.

## 2. Semver por paquete

- **major** — cambio incompatible: eliminar un campo, hacer obligatorio uno opcional, estrechar un enum, cambiar el significado de un valor existente.
- **minor** — añadir un campo opcional, ampliar un enum de *entrada*, añadir un endpoint.
- **patch** — documentación, ejemplos, corrección de una descripción.

**Cuidado con los enums.** Ampliar un enum es *minor* si el consumidor lo recibe pero *major* si el consumidor debe emitirlo. Un `EVENT.kind` nuevo es minor (los SDKs ignoran lo que no conocen; la regla "ignora lo desconocido" está en la spec de los SDKs). Un `shutdownReason` nuevo también. Un valor nuevo obligatorio en `COMMAND` sería major.

## 3. Versión del protocolo vs. versión del paquete

Son dos cosas distintas y no hay que confundirlas:

- **`proto: "arena/1"`** es el identificador de la *familia* de protocolo. Solo cambia con un rediseño incompatible (`arena/2`), y entonces el motor debe soportar ambas familias durante una temporada completa antes de retirar la vieja.
- **`@arena/protocol@1.3.0`** es la versión del paquete de esquemas dentro de esa familia. Los cambios minor añaden campos opcionales sin romper a nadie.

Un motor que anuncia `arena/1` y un bot compilado contra `@arena/protocol@1.0.0` deben poder jugar aunque el motor esté en `1.3.0`. Esto es lo que hace posible que un bot inscrito en un torneo siga siendo válido semanas después.

**Regla de oro de los SDKs:** ignora los campos que no conoces, nunca falles por un campo de más. La suite de contract tests (E5/T5.3) incluye un caso con un campo desconocido que el SDK debe atravesar sin romperse.

## 4. Tabla de compatibilidad

Se actualiza en cada release y es la fuente de verdad para saber qué puede jugar contra qué. La mantiene E1; E9 la consulta antes de aceptar una inscripción a un torneo.

| Release | Motor | Protocolo (familia / paquete) | SDK Python | SDK JS | Catálogo | Map schema |
|---|---|---|---|---|---|---|
| _(pendiente M1)_ | 0.1.x | arena/1 · 0.1.x | 0.1.x | 0.1.x | mvp@1 | 1 |

**Lockstep de SDKs.** Los SDKs comparten `major.minor` con `@arena/protocol`. Un `arena-sdk-python@0.3.x` habla `@arena/protocol@0.3.x`. El parche es libre.

## 5. Proceso de cambio (RFC ligera)

Ningún cambio en `packages/*` ni en `openapi.yaml` se fusiona sin pasar por esto:

1. **Issue de RFC** con la plantilla `contract-change`: qué cambia, por qué, quién lo consume, si es major/minor/patch, y el plan de migración si es major.
2. **Revisión de los equipos afectados.** Todo cambio del protocolo requiere la aprobación de E2 y E5. Todo cambio que toque sandbox, artefactos o permisos requiere además la de **E6** (que tiene veto de seguridad, T10.1/CODEOWNERS).
3. **Bump de versión** con changesets y actualización del CHANGELOG del paquete.
4. **Ejemplos actualizados**: un campo nuevo sin ejemplo válido no se fusiona.
5. **Tabla de compatibilidad actualizada** en este documento.
6. CI verde, incluidas las suites de esquemas y las batallas golden de E2 (un cambio de contrato que altera un resultado determinista es una señal de alarma, no un detalle).

## 6. Congelación durante torneos

Cuando un torneo cierra inscripciones (E9/T9.4), quedan congelados para todas sus batallas: versión de motor, de protocolo, de reglas, de catálogo, de mapa y los artefactos de bot. Un release nuevo de cualquier paquete **no afecta** a un torneo en curso. Esto es lo que permite desplegar sin cancelar competiciones y es un test explícito de E9 (T9.4).

## 7. Deprecación

Nada se elimina sin aviso:

- Un campo marcado deprecado sobrevive **al menos una temporada completa** y sigue emitiéndose.
- La API HTTP sirve bajo `/api/v1`; una `v2` convive con `v1` un mínimo de 6 meses (pensando en la "API pública para ligas de terceros" del capítulo 29).
- Una familia de protocolo retirada (`arena/1` → `arena/2`) exige que el motor soporte ambas mientras haya bots publicados que hablen la vieja.
