# Suite de escape del sandbox (E6 · T6.2)

Bots maliciosos deliberados que intentan romper los controles de la **tabla 18.2**. Cada
uno prueba un vector distinto; el sandbox debe contenerlos todos.

| Bot | Vector de ataque | Control que lo bloquea (18.2) |
|-----|------------------|-------------------------------|
| `01_internet_connect` | Conexión saliente a Internet | Red solo `arena`, sin DNS externo |
| `02_write_outside_tmp` | Escritura fuera de `/tmp` | Rootfs `--read-only`, solo tmpfs `/tmp` |
| `03_fork_bomb` | Fork bomb (agotar PIDs) | `--pids-limit` + deadline de ejecución |
| `04_memory_exhaustion` | Agotar RAM del host | `--memory` (OOM por contenedor) |
| `05_internal_network_scan` | Escanear/atacar la red interna | Segmentación: solo el endpoint del motor |
| `06_read_proc_sensitive` | Leer `/proc` y secretos | `--cap-drop ALL`, seccomp, sin secretos montados |
| `07_docker_sock` | Abrir `docker.sock` | El socket **nunca** se monta |

## Cómo se verifican

Con Docker disponible:

```bash
./run-escape-suite.sh arena/bot-runtime-python@sha256:<digest>
```

El script lanza cada bot con los **mismos flags** que
`DockerContainerRunner.buildRunArgs()` (`apps/bot-manager/src/container-runner.ts`) y
falla (exit 1) si algún bot imprime un marcador de escape (`ESCAPE-OK`,
`ESCAPE-CRITICAL`, `LEAK`).

## Estado en esta máquina

`ia02` **no está en el grupo docker** (sin sudo). La suite está **escrita y lista** pero
**no se ha ejecutado aquí**. La lógica que SÍ es verificable sin Docker —los flags
generados, el parser de `docker inspect` y el escáner del Compose— tiene tests reales en
`apps/bot-manager/tests/container-runner.test.ts` y `compose-scan.test.ts`. Ver
`docs/historial/entrega-E6.md` para el desglose "verificado vs pendiente de entorno".

El test `apps/bot-manager/tests/sandbox-escape-suite.test.ts` verifica de verdad que la
suite está **completa** (los 7 vectores presentes y consistentes con el manifiesto).
