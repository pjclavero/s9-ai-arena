#!/usr/bin/env python3
"""DIAG · Calibración de las pruebas del tap pasivo de ingesta (apps/streamer/src/tap.ts).

Cada mutante rompe UNA garantía y debe poner en ROJO el test indicado (fragmento de su
nombre en la salida de vitest). Antes, la base debe estar en VERDE. En serie, nunca en
paralelo, y sobre un árbol COMMITEADO: cada mutante se revierte al terminar.

Uso: python3 scripts/stream-tap-mutants.py [--json salida.json] [TAP-M1 TAP-M2 ...]
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEST = "apps/streamer/src/stream-tap.test.ts"
TAP = "apps/streamer/src/tap.ts"
SUP = "apps/streamer/src/supervisor.ts"

# (id, garantía, fichero, ancla, sustituto, fragmento del test que debe fallar)
M = [
    ("TAP-M1", "G1 OFF por defecto", TAP,
     '    enabled: flag === "true" || flag === "1",',
     '    enabled: flag !== "false" && flag !== "0",',
     "sin variables"),
    ("TAP-M2", "G1 OFF por defecto (factoría)", TAP,
     "  if (!config.enabled) return null;\n",
     "",
     "sin variables"),
    ("TAP-M3", "G2 salida idéntica (el tap escribe en el trozo)", TAP,
     "      this.consume(chunk);\n",
     "      this.consume(chunk);\n      if (chunk.length > 64) chunk[chunk.length - 1] ^= 0xff;\n",
     "hash del flujo"),
    ("TAP-M4", "G3 sin backpressure (el tap pausa a ffmpeg)", SUP,
     "        if (!accepting) media.pause();",
     '        if (!accepting || (tap && "stats" in tap && tap.stats.dropped > 0)) media.pause();',
     "hash del flujo"),
    ("TAP-M5", "G3 no bloquea (escrituras encoladas sin límite)", TAP,
     "    if (this.writing) {",
     "    if (false) {",
     "disco COLGADO"),
    ("TAP-M6", "G3 un tap que falla no rompe la emisión", SUP,
     "          try {\n            tap.observe(chunk);\n          } catch {\n"
     "            /* observe() no lanza; defensa en profundidad: el relé nunca se entera */\n          }\n",
     "          tap.observe(chunk);\n",
     "LANZA"),
    ("TAP-M7", "G4 rotación (no se borra nada)", TAP,
     "      await this.rotate();\n",
     "",
     "maxFiles:"),
    ("TAP-M8", "G4 límite de bytes ignorado", TAP,
     " || total() > this.config.maxBytes",
     "",
     "maxBytes:"),
    ("TAP-M9", "G4 rota la MÁS NUEVA en vez de la más antigua", TAP,
     "      const victim = list[0];",
     "      const victim = list[list.length - 1];",
     "maxFiles:"),
    ("TAP-M10", "G4 tras reinicio no cuenta las capturas previas", TAP,
     "          this.files.push({ name, bytes: st.size });\n",
     "",
     "tras un reinicio"),
    ("TAP-M11", "G5 la clave llega al tap", SUP,
     "      tap?.beginStream();\n",
     "      tap?.beginStream();\n"
     '      if (tap && "stats" in tap) (tap.stats as unknown as Record<string, unknown>).ingest = this.key;\n',
     "emisión con clave"),
    ("TAP-M12", "G6 captura cualquier fotograma, no sólo keyframes", TAP,
     "frameType === 1) {",
     "frameType >= 1) {",
     "trozos aleatorios"),
    ("TAP-M13", "P2 el tap añade latencia al relé (busy-wait de 40 ms en observe)", TAP,
     "      this.stats.bytesSeen += chunk.length;\n",
     "      this.stats.bytesSeen += chunk.length;\n"
     "      for (const t0 = Date.now(); Date.now() - t0 < 40;) { /* busy-wait */ }\n",
     "p95 < 2 ms"),
    ("TAP-M14", "P3 el tap observa ANTES de la pausa por backpressure", SUP,
     "        if (!accepting) media.pause();\n"
     "        // DIAG · el tap observa DESPUÉS del relé y de la pausa, y no decide nada: su\n"
     "        // resultado no existe para el control de flujo (sólo `accepting` pausa a ffmpeg).\n"
     "        if (tap) {\n"
     "          try {\n"
     "            tap.observe(chunk);\n"
     "          } catch {\n"
     "            /* observe() no lanza; defensa en profundidad: el relé nunca se entera */\n"
     "          }\n"
     "        }\n",
     "        if (tap) {\n"
     "          try {\n"
     "            tap.observe(chunk);\n"
     "          } catch {\n"
     "            /* observe() no lanza; defensa en profundidad: el relé nunca se entera */\n"
     "          }\n"
     "        }\n"
     "        if (!accepting) media.pause();\n",
     "orden en el camino caliente"),
    ("TAP-M15", "P3 el .flv queda huérfano si falla el .json", TAP,
     "        await this.fs.unlink(join(dir, `${base}.flv`)).catch(() => {});\n",
     "",
     "sin huérfanos"),
    ("TAP-M16", "P3 rotate cuenta rotatedFiles aunque unlink falle", TAP,
     "          await this.fs.unlink(join(this.config.dir, name));\n          this.stats.rotatedFiles++;\n",
     "          this.stats.rotatedFiles++;\n          await this.fs.unlink(join(this.config.dir, name));\n",
     "rotate no cuenta"),
    ("TAP-M17", "P3 jpegBusy se queda activo si decode lanza síncrono", "apps/streamer/src/control.ts",
     "        void Promise.resolve()\n          .then(() => decode(found.flvPath))\n",
     "        void decode(found.flvPath)\n",
     "jpegBusy se libera"),
    ("TAP-M18", "P3 flush() del temporizador sin try/catch", TAP,
     "      try {\n        this.flush();\n      } catch {\n        // flush() no debería lanzar; si lo hiciera, nunca debe tumbar el proceso del streamer.\n        this.stats.writeErrors++;\n      }\n",
     "      this.flush();\n",
     "flush() lanzando desde el temporizador"),
]

# Mutantes lentos por construcción (otros tests alimentan byte a byte): se ejecutan sólo
# con el test que los debe matar, para que la muerte sea por ASERCIÓN y no por timeout.
ONLY_TEST = {"TAP-M13": "P2 ·"}


def sh(cmd):
    return subprocess.run(cmd, cwd=ROOT, shell=True, capture_output=True, text=True)


def vitest(name_filter=None):
    flt = f" -t '{name_filter}'" if name_filter else ""
    r = sh(f"timeout 300 npx vitest run {TEST}{flt} 2>&1")
    out = re.sub(r"\x1b\[[0-9;]*m", "", r.stdout + r.stderr)
    m = re.search(r"Tests\s+(?:(\d+) failed \| )?(\d+) passed", out)
    return r.returncode, out, m.group(0) if m else None


args = sys.argv[1:]
json_out = None
if "--json" in args:
    i = args.index("--json")
    json_out = args[i + 1]
    del args[i : i + 2]
only = args

head = sh("git rev-parse HEAD").stdout.strip()
summary = {"head": head, "test": TEST, "baseline": None, "mutants": [], "calibration_failures": 0}

rc, out, line = vitest()
open("/tmp/stream-tap-mut-BASE.log", "w").write(out)
summary["baseline"] = {"rc": rc, "tests": line}
print(f"BASE: rc={rc} {line}", flush=True)
if rc != 0:
    print("BASE EN ROJO: no se calibra", flush=True)
    summary["calibration_failures"] = 1
    if json_out:
        json.dump(summary, open(json_out, "w"), indent=2, ensure_ascii=False)
    sys.exit(2)

fails = 0
for tag, guarantee, path, old, new, frag in M:
    if only and tag not in only:
        continue
    p = os.path.join(ROOT, path)
    src = open(p).read()
    entry = {"id": tag, "guarantee": guarantee, "file": path, "expected_red": frag}
    if src.count(old) != 1:
        entry.update(verdict="ANCLA_NO_UNICA", count=src.count(old))
        print(f"{tag}: ANCLA NO ÚNICA ({src.count(old)}) -> MUTANTE INVÁLIDO", flush=True)
        fails += 1
        summary["mutants"].append(entry)
        continue
    open(p, "w").write(src.replace(old, new))
    try:
        rc, out, line = vitest(ONLY_TEST.get(tag))
        open(f"/tmp/stream-tap-mut-{tag}.log", "w").write(out)
        red = rc != 0 and re.search(r"\d+ failed", out) is not None
        failed_lines = [l for l in out.splitlines() if "×" in l or "FAIL" in l]
        reason = any(frag in l for l in failed_lines)
        by_assertion = "AssertionError" in out and "timed out" not in out and rc != 124
        reason = reason and by_assertion
        entry["by_assertion"] = by_assertion
        verdict = "ROJO-OK" if (red and reason) else ("ROJO-RAZON?" if red else "VERDE (mutante vivo)")
        if verdict != "ROJO-OK":
            fails += 1
        entry.update(rc=rc, tests=line, verdict=verdict, failed=[l.strip()[:200] for l in failed_lines][:6])
        print(f"{tag} {guarantee}: rc={rc} {line} {verdict}", flush=True)
    finally:
        open(p, "w").write(src)
    summary["mutants"].append(entry)

rc, out, line = vitest()
summary["after"] = {"rc": rc, "tests": line}
d = sh("git status --porcelain --untracked-files=no").stdout.strip()
summary["tree_clean"] = not d
summary["calibration_failures"] = fails + (0 if rc == 0 else 1) + (0 if not d else 1)
print(f"DESPUÉS: rc={rc} {line}")
print("ARBOL_LIMPIO" if not d else "ARBOL_SUCIO:\n" + d)
print(f"RESUMEN fallos_calibracion={summary['calibration_failures']}")
if json_out:
    json.dump(summary, open(json_out, "w"), indent=2, ensure_ascii=False)
sys.exit(1 if summary["calibration_failures"] else 0)
