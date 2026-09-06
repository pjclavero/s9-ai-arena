/**
 * DEGRADACIÓN DEL WORKER · diferencial de CALIBRACIÓN.
 *
 * Muta el CÓDIGO DE PRODUCCIÓN (worker.ts y redis-signal.ts, no las sondas) y
 * exige que `apps/tournament-worker/src/worker-degradation.test.ts` se ponga
 * ROJA con cada estropicio. Una suite que sobrevive a estas mutaciones no
 * comprueba lo que dice comprobar.
 *
 * La mutación M1 es la obligatoria del encargo: devolver el `.catch()` a un
 * retorno inmediato —el bucle pierde su única pausa— tiene que salir en ROJO.
 *
 * Uso recomendado:  bash scripts/worker-degradation-mutants.sh
 *   El guion de shell es quien EJECUTA la suite; este módulo aporta la lista de
 *   mutaciones y sabe aplicarlas y deshacerlas. Se separó así por un motivo
 *   medido, no estético: en este entorno, un `npx vitest` lanzado desde un
 *   proceso Node padre se queda colgado sin ejecutar un solo test (90 s de
 *   reloj, cero salida), mientras el MISMO comando desde el shell termina en
 *   10 s. Un arnés que se cuelga no mide nada, así que la ejecución vive donde
 *   se sabe que funciona.
 *
 * Órdenes de este módulo:
 *   --listar            un mutante por línea: "<i>\t<descripción>"
 *   --aplicar <i>       aplica el mutante i sobre el árbol (rc=2 si el ancla
 *                       ya no existe: el mutante habría que actualizarlo)
 *   --restaurar         devuelve los ficheros a su estado original
 *   --verificar         rc=0 si el árbol está limpio, rc=1 si quedó mutado
 *
 * El original vive en <fichero>.mutation-backup mientras dura la sesión, y
 * --restaurar lo repone; el guion de shell restaura SIEMPRE, también si lo
 * interrumpen.
 */
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const WORKER = "apps/tournament-worker/src/worker.ts";
const SIGNAL = "apps/tournament-worker/src/redis-signal.ts";
const SUITE = "apps/tournament-worker/src/worker-degradation.test.ts";

const MUTANTS = [
  {
    name: "M1 · el `.catch()` vuelve a retornar al instante: el bucle pierde su ÚNICA pausa (el defecto del encargo)",
    file: WORKER,
    from: "      if (!hadWork && this.running) await this.pausar(pollMs);",
    to: `      if (!hadWork && this.running) {
        if (this.config.signal) {
          await this.config.signal.wait("jobs", Math.ceil(pollMs / 1000)).catch(() => undefined);
        } else {
          await new Promise((r) => setTimeout(r, pollMs));
        }
      }`,
  },
  {
    name: "M2 · el freno desaparece: tras fallar la señal ya no se duerme lo que quedaba de pausa",
    file: WORKER,
    from: "    const restante = pollMs - (Date.now() - inicio);\n    if (restante > 0) await dormir(restante);",
    to: "    /* mutante: sin freno */",
  },
  {
    name: "M3 · la espera deja de tener vencimiento: una señal colgada vuelve a parar el bucle para siempre",
    file: WORKER,
    from: '        await conVencimiento(espera, timeoutS * 1000 + (this.config.signalGraceMs ?? 2000), "signal.wait vencido");',
    to: "        await espera;",
  },
  {
    name: "M4 · degradar deja de notificarse (se degrada en silencio)",
    file: WORKER,
    from: "        this.config.onSignalError?.(err, { degradado: true, fallos: this.signalStats.fallos });",
    to: "        /* mutante: en silencio */",
  },
  {
    name: "M5 · no se marca la degradación: se sigue llamando a una señal muerta en cada vuelta",
    file: WORKER,
    from: "        this.signalDegradado = true;\n        this.signalStats.fallos++;",
    to: "        this.signalStats.fallos++;",
  },
  {
    name: "M6 · nunca se reintenta la reconexión: al volver Redis el worker se queda en polling para siempre",
    file: WORKER,
    from: "      await this.reintentarSignal(signal);",
    to: "      /* mutante: sin reconexión */",
  },
  {
    name: "M7 · el reintento de reconexión pierde su freno (tormenta de connect())",
    file: WORKER,
    from: "    if (Date.now() - this.ultimoReintentoSignal < cada) return;",
    to: "    if (false) return;",
  },
  {
    name: "M8 · el socket que muere deja de rechazar a quien espera (la parálisis silenciosa medida)",
    file: SIGNAL,
    from: "    for (const w of pendientes) w.reject(motivo);",
    to: "    /* mutante: los waiters se quedan esperando */",
  },
  {
    name: "M9 · nadie escucha el cierre del socket: wait() vuelve a colgarse",
    file: SIGNAL,
    from: '        s.on("close", () => this.cerrar(new RedisSignalDesconectado("socket cerrado")));',
    to: "        /* mutante: sin manejador de cierre */",
  },
  {
    name: "M10 · nadie escucha el error del socket (RST): wait() vuelve a colgarse",
    file: SIGNAL,
    from: '        s.on("error", (e: Error) => this.cerrar(new RedisSignalDesconectado(e.message)));',
    to: "        /* mutante: sin manejador de error */",
  },
  // M11 retirado a propósito: cambiar el `return Promise.reject(...)` de send()
  // por un `throw` síncrono es un mutante EQUIVALENTE. `wait()` es `async`, así
  // que el throw se convierte igualmente en promesa rechazada para quien espera
  // y NO hay efecto observable que lo distinga. Mantenerlo en la lista sólo
  // serviría para fingir una garantía que nadie puede comprobar. La forma con
  // `Promise.reject` se conserva por claridad del contrato, no por conducta.
  {
    name: "M12 · reconectar deja waiters de la sesión vieja colgados",
    file: SIGNAL,
    from: '    this.cerrar(new RedisSignalDesconectado("reconexión"));',
    to: "    /* mutante: sin cerrar la sesión anterior */",
  },
];

const RESPALDO = (f) => `${f}.mutation-backup`;

function guardarRespaldos() {
  for (const f of [WORKER, SIGNAL]) if (!existsSync(RESPALDO(f))) copyFileSync(f, RESPALDO(f));
}

function restaurar() {
  for (const f of [WORKER, SIGNAL]) {
    if (existsSync(RESPALDO(f))) {
      copyFileSync(RESPALDO(f), f);
      unlinkSync(RESPALDO(f));
    }
  }
}

function arbolLimpio() {
  // Se comprueba por EFECTO, y contra TODOS los mutantes, no por «ya llamé a
  // restaurar». Dos arneses a la vez dejaron un mutante puesto en el árbol y
  // todo lo medido después fue basura; buscar sólo la marca `/* mutante: */`
  // NO bastó, porque hay mutaciones (M1) cuyo texto no lleva marca ninguna. La
  // comprobación honesta es: el ANCLA de cada mutante sigue en su sitio.
  const contenido = new Map([WORKER, SIGNAL].map((f) => [f, readFileSync(f, "utf8")]));
  const perdidas = MUTANTS.filter((m) => !contenido.get(m.file).includes(m.from)).map((m) => m.name);
  const marcas = [...contenido.values()].some((t) => t.includes("/* mutante:"));
  return { limpio: perdidas.length === 0 && !marcas, perdidas, marcas };
}

const argv = process.argv.slice(2);
const orden = argv[0] ?? "--listar";

if (orden === "--listar") {
  MUTANTS.forEach((m, i) => console.log(`${i}\t${m.name}`));
  process.exit(0);
}

if (orden === "--verificar") {
  const r = arbolLimpio();
  console.log(
    r.limpio
      ? "arbol limpio (los anclajes de los 11 mutantes siguen en su sitio)"
      : `ARBOL CONTAMINADO · anclas perdidas: ${r.perdidas.join(" | ") || "(ninguna)"}${r.marcas ? " · quedan marcas /* mutante: */" : ""}`,
  );
  process.exit(r.limpio ? 0 : 1);
}

if (orden === "--restaurar") {
  restaurar();
  const r = arbolLimpio();
  console.log(r.limpio ? "restaurado" : `ARBOL CONTAMINADO tras restaurar · ${r.perdidas.join(" | ")}`);
  process.exit(r.limpio ? 0 : 1);
}

if (orden === "--aplicar") {
  const i = Number(argv[1]);
  const m = MUTANTS[i];
  if (!m) {
    console.error(`no existe el mutante ${argv[1]}`);
    process.exit(2);
  }
  guardarRespaldos();
  const original = readFileSync(RESPALDO(m.file), "utf8");
  if (!original.includes(m.from)) {
    console.error(`ANCLA PERDIDA · ${m.name}`);
    process.exit(2);
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  console.log(`aplicado ${i} · ${m.name}`);
  process.exit(0);
}

console.error(`orden desconocida: ${orden}`);
process.exit(2);
