# ADR-018 · Semántica del scan: cinco estados, no dos

- **Estado**: aceptado
- **Ámbito**: el job `scan` de `.github/workflows/ci.yml` (npm audit, Trivy,
  escáner de Compose) y su lectura en el semáforo.
- **Complementa a**: ADR-016/ADR-017 (identidad y contrato de release) y al gate
  de digest de #138, que ya tuvo que separar `N2_REGISTRO_INACCESIBLE` de
  `N2_DIGEST_NO_RESUELVE` porque Docker Hub devolvió `429`. Es el mismo patrón:
  **cada punto donde dependemos de un servicio externo para afirmar algo
  necesita un estado propio para «no pude comprobarlo»**.
- **Utillaje**: contrato en `packages/readiness/scan-status.mjs`, ejecutor en
  `infrastructure/scripts/scan-gate.mjs`, semáforo en
  `infrastructure/scripts/ci-gate.mjs`; pruebas en
  `infrastructure/tests/scan-status.test.ts` y `scan-gate.test.ts`; calibración
  por mutación en `infrastructure/scripts/scan-status-mutations.mjs`.

> Ninguna regla de aquí es una buena práctica genérica: cada una viene de un
> fallo medido en este repositorio y cada una tiene una prueba capaz de ponerse
> roja.

## 1. El incidente

`main` se puso ROJO y bloqueó la promoción sin que hubiera vulnerabilidad
alguna:

```
npm notice This endpoint is being retired. Use the bulk advisory endpoint instead.
npm error audit endpoint returned an error       (tras 6 minutos de espera)

semaforo -> "FALLO DE SEGURIDAD (... npm audit): bloquea la promoción"
```

Una reejecución del **mismo commit**, sin cambiar una línea, salió verde: 27
success. El endpoint de auditoría devolvió un error y el gate lo tradujo a
«fallo de seguridad».

**El fallo peligroso es el simétrico, y ese día no se habría visto.** Si el
endpoint hubiera devuelto `200` con un cuerpo vacío o degradado, `npm audit`
habría salido con `0` y el semáforo habría dicho VERDE **sin haber auditado
nada**. Con dos estados —éxito y fallo— un verde por no haber mirado es
indistinguible de un verde por no haber encontrado nada.

## 2. Los cinco estados

| Estado | Significa | Afirma sobre |
|---|---|---|
| `CLEAN` | el escáner corrió y no encontró nada | las vulnerabilidades |
| `FINDINGS` | el escáner corrió y encontró hallazgos | las vulnerabilidades |
| `NOT_EXERCISED` | no se ha comprobado | la comprobación |
| `SCAN_ERROR` | la herramienta falló | la comprobación |
| `SOURCE_UNAVAILABLE` | la fuente de datos no estaba disponible (red, rate-limit, endpoint caído) | la comprobación |

Son **dos ejes** y no se colapsan: los dos primeros hablan del árbol, los tres
últimos hablan de si llegamos a mirarlo.

## 3. El mapeo a readiness es un DATO

`ESTADO_SCAN_A_READINESS` (en `packages/readiness/scan-status.mjs`) se declara
como tabla, igual que `ESTADO_DRIFT_A_READINESS` en `checks.ts`, y por la misma
razón: un contrato que hay que reconstruir siguiendo las ramas de un `switch` no
se puede leer entero, ni probar entero, ni mutar entero.

| Estado | readiness |
|---|---|
| `CLEAN` | `verified` |
| `FINDINGS` | `failed` |
| `NOT_EXERCISED` | `not_exercised` |
| `SCAN_ERROR` | `not_exercised` o `failed`, **según política declarada** |
| `SOURCE_UNAVAILABLE` | `not_exercised` |

Política declarada para `SCAN_ERROR` (`POLITICA_SCAN_ERROR`):

- `npm-audit` y `trivy` → `not_exercised`. Una herramienta que se rompe no ha
  encontrado nada; llamarlo `failed` inventaría un hallazgo que nadie vio.
- `compose` → `failed`. Ese escáner es local y determinista, sin red ni base de
  datos que se caiga: si se rompe, lo que está roto es el repositorio.

**Reglas duras**, las dos con mutación que las calibra:

1. Un fallo de red, de límite de tasa o de herramienta **nunca** se transforma en
   «0 vulnerabilidades». El único camino a `verified` es la entrada literal
   `CLEAN`.
2. Un estado que no esté en la tabla **no cae al camino permisivo**: va a
   `not_exercised`, que bloquea.

## 4. El vocabulario se consume, no se reimplementa

`verified` / `failed` / `not_exercised` son los de `CheckStatus`
(`packages/readiness/engine.ts`). `scan-status.test.ts` lo comprueba **a nivel de
tipo** (una asignación a `CheckStatus` que rompería `npm run typecheck`) y a
nivel de dato (los destinos de la tabla pertenecen al vocabulario que ya usa
`ESTADO_DRIFT_A_READINESS`).

## 5. Qué cambia en el pipeline

- El job `scan` **declara** `outputs.estado` y `outputs.readiness`. El semáforo
  ya no lo juzga por `success`/`failure`: aplica la tabla. Un `success` mudo, sin
  estado declarado, es ROJO por fail-closed — antes era verde.
- `npm audit` se ejecuta con `--json` y el veredicto sale del **informe**, no del
  código de salida (que vale `1` tanto por vulnerabilidad como por caída del
  endpoint). Un informe vacío, sin `auditReportVersion` o sin recuentos por
  severidad es `SCAN_ERROR`, **nunca** `CLEAN`.
- **Trivy** corre con `exit-code: "0"` y `format: json`: el código de salida deja
  de ser el veredicto. Un informe **sin objetivos escaneados** (`Results` vacío o
  ausente) es `SCAN_ERROR`, no «árbol limpio»: sobre este repositorio siempre hay
  al menos un objetivo. Un fallo de descarga de su base de datos —su registro
  aplica límites de tasa— es `SOURCE_UNAVAILABLE`.
- El **escáner de Compose** no puede dar `SOURCE_UNAVAILABLE` (no tiene fuente
  externa). Un `exit 0` sin línea de veredicto es `SCAN_ERROR`: no hay prueba de
  que mirara nada. Que el escáner no exista es `NOT_EXERCISED`, no verde — es el
  agujero que ya tuvo este repositorio con un `if: hashFiles(...)`.
- Si un escáner **no declara nada** (su paso se saltó, o alguien lo borró del
  workflow), `ESCANERES_ESPERADOS` lo cuenta como `NOT_EXERCISED`. Borrar un
  escáner no puede salir verde.

## 6. El semáforo dice POR QUÉ bloquea

«Encontré hallazgos» y «no pude comprobar» **bloquean los dos**, pero con nombre
distinto:

- `HALLAZGOS DE SEGURIDAD (FINDINGS → failed)` — hay que arreglar código.
- `SEGURIDAD NO COMPROBADA (SOURCE_UNAVAILABLE → not_exercised) · procede
  REINTENTAR` — no hay nada que arreglar en el commit.

Sólo la fuente caída se marca reintentable, y sólo ella se reintenta dentro del
propio job (tres intentos, con la razón anotada como `::warning::` en cada uno).
Un hallazgo no se reintenta: reintentar un hallazgo es esconderlo.

## 7. El aviso de retirada del endpoint

`npm notice This endpoint is being retired. Use the bulk advisory endpoint
instead.` viene del **quick audit** (`POST /-/npm/v1/security/audits/quick`), el
endpoint que npm está retirando. El sustituto es el **bulk advisory endpoint**
(`POST /-/npm/v1/security/advisories/bulk`), que es el que usa `npm audit` en su
camino moderno con un lockfile v2/v3.

Camino adoptado, en tres pasos y por orden de coste:

1. **Ahora**: `npm audit --json` sobre el `package-lock.json` del repositorio
   (lockfileVersion 3), que es la ruta que consulta el endpoint bulk. Además el
   ejecutor **detecta el aviso** y lo emite como `::warning::` en cada run: si
   alguna dependencia del cálculo nos devolviera al camino retirado, se verá
   antes de que deje de responder, no el día que caiga.
2. **Ya en vigor**: npm ha dejado de ser la única fuente. Trivy analiza el mismo
   árbol con su propia base de datos, y los dos declaran estado por separado. Si
   npm queda `SOURCE_UNAVAILABLE`, el run bloquea como **no comprobado**, pero se
   sabe exactamente qué se comprobó y qué no.
3. **Si el bulk endpoint también se retirase o se degradase**: la sustitución es
   cambiar el escáner de dependencias (Trivy ya cubre el lockfile; `osv-scanner`
   es la alternativa directa) sin tocar el contrato — el resto del pipeline
   depende de los cinco estados, no de qué herramienta los produce.

Lo que este ADR **no** hace: apagar `npm audit` para «arreglar» el ruido. El
ruido no era `npm audit`, era leer su fallo como un veredicto de seguridad.

## 8. Calibración

`infrastructure/scripts/scan-status-mutations.mjs` estropea los ficheros de
producción y exige que las suites se pongan rojas. Ocho mutaciones, las cinco
primeras son exactamente los fallos que este ADR impide:

| # | Mutación |
|---|---|
| M1 | `SOURCE_UNAVAILABLE` tratado como `CLEAN` |
| M2 | `SCAN_ERROR` tratado como `CLEAN` |
| M3 | una respuesta vacía o degradada del endpoint leída como «0 vulnerabilidades» |
| M4 | un estado no contemplado cayendo al camino permisivo |
| M5 | el semáforo perdiendo la distinción entre «hallazgos» y «no comprobado» |
| M6 | un escáner que no declara nada deja de contar |
| M7 | un informe de Trivy sin objetivos escaneados dado por limpio |
| M8 | el semáforo volviendo a deducir el veredicto del código de salida del job |

El harness corre en la CI dentro de un job **obligatorio** (`image-provenance`,
junto a la calibración del contrato de despliegue) y arranca con un control
positivo: si la suite no está verde **antes** de mutar, no afirma nada.
