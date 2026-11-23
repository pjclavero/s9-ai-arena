# Concurrencia del tournament-worker

Cuántas batallas ejecuta a la vez cada `tournament-worker`. Variable:
`TOURNAMENT_WORKER_CONCURRENCY` (ver [configuración](configuration.md)).

## Qué se decide y por qué

| Valor | Efecto |
|---|---|
| ausente o vacío | **1** batalla simultánea (defecto de worker y de `infrastructure/docker-compose.yml`) |
| entero `1..16` | ese número de batallas, sin cálculo |
| `auto` | cálculo con los límites efectivos del cgroup y el tamaño de batalla (abajo) |
| cualquier otra cosa | el worker NO arranca (no se degrada en silencio) |

El defecto es 1 porque el cálculo anterior (`min(vCPU-1, RAM/2 GiB)` con la vista del
host) daba 3 en una máquina de 4 vCPU, y una 4v4 son 8 contenedores de bot a 0,5 CPU,
256 MiB y 64 PIDs: 3 batallas = 12 CPU y 6 GiB de límites más el motor, justo el
escenario que causó soft lockups en producción (AUD2-10).

## Coste de una batalla

Cada bot es un contenedor con límites fijos (`DEFAULT_LIMITS` de `bot-manager`):
0,5 CPU, 256 MiB, 64 PIDs. Además el motor corre dentro del proceso del worker.

| Tamaño | Bots (contenedores) | CPU de límites | Memoria de límites |
|---|---|---|---|
| 1v1 | 2 | 1 | 0,5 GiB |
| 2v2 | 4 | 2 | 1 GiB |
| 3v3 | 6 | 3 | 1,5 GiB |
| 4v4 | 8 | 4 | 2 GiB |

Son techos (límites), no consumo medido. Mediciones reales: ver el informe del carril
y `scripts/ops/measure-battle-cost.ts`.

## Máximo seguro con la emisión (D-OP-32)

La concurrencia máxima segura por tipo de batalla, con y sin emisión 1080p30, y el cálculo de RAM y CPU
en 6 vCPU y 6,84 GB están en [resource-budget.md](resource-budget.md#concurrencia-máxima-segura-del-worker)
y los comprueba `infrastructure/tests/resource-budget.test.ts`. Resumen: con emisión, 1v1 hasta 2 y
2v2, 3v3 y 4v4 sólo de una en una; sin emisión, 1v1 hasta 3, 2v2 hasta 2 y 3v3 y 4v4 de una en una.

## Fórmula de `auto`

```
porCPU = floor((CPU_efectivas − 0,5) / (0,5 · bots))
porRAM = floor(RAM_libre_GiB / (0,25 · bots + 0,5))
concurrencia = max(1, min(16, porCPU, porRAM))        con bots = 8 (la 4v4)
```

- `CPU_efectivas` y la RAM salen del cgroup del propio proceso (v2: `cpu.max`,
  `memory.max`/`memory.current`; v1: `cpu.cfs_*`, `memory.limit_in_bytes`) y nunca
  superan lo que ve el host; sin cgroup, se usa la RAM LIBRE del host.
- Con `cgroupns=host`, o si el proceso está en la raíz del cgroup v2, `/sys/fs/cgroup`
  muestra el cgroup del host o ninguno: `auto` usa entonces los valores del host (CPU
  totales y memoria libre del host), no los del contenedor. Comprueba que el worker
  corre en su propio espacio de nombres de cgroup antes de fiarte de `auto`.
- Se dimensiona para la batalla más grande porque un hueco del worker puede recibir
  cualquiera.
- Los contenedores de bot los crea el docker-proxy como hermanos del worker, no dentro
  de su cgroup: el cgroup del worker sólo describe lo que el worker «cree» tener. En un
  host compartido, `auto` es un techo optimista; no lo uses en producción sin medir.

## Qué hacer en una instalación existente

El `.env` manda. Si `TOURNAMENT_WORKER_CONCURRENCY` estaba vacío, el worker pasa a 1
al actualizar (los torneos serán más lentos pero estables). Para subirlo: fíjalo
explícitamente tras medir una 4v4 real con el hipervisor en reposo y comprueba la
carga (PSI, soft lockups) durante la medición.
