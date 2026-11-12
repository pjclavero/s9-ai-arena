#!/usr/bin/env python3
"""OLA 2 · MD · Matriz de mutantes de replay v2 / verify / stateHash / RNG con nombre (22: M01-M22).

Origen: `/srv/s9-test/md-mutants.sh` (VM112, perl -pe; no estaba en el repo) + `md-m04.sh`
(M04 rehecho tras prettier) + `m0-md-m10b.sh` (M10 con ancla inequívoca, de M0). G1 lo trae
al repo con el runner común (mutlib.py): cada ancla debe aparecer EXACTAMENTE una vez.

Cambio de G1: M10 usaba `projectiles: this.projectiles,`, que tras el merge de MA aparece DOS
veces en battle.ts (internalFrame() y stateHashInput()); perl sustituía la primera, la del
frame interno, y el mutante era EQUIVALENTE para el hash. Ahora el ancla es el par
proyectiles+minas del sitio del hash (única). M11 se ancla igual por coherencia.

Cada mutante pone en rojo el test de md-replay-v2.test.ts que nombra su filtro (-t).
Uso (VM112, dentro de flock): python3 -I scripts/hardening/md-mutants.py <worktree> <salida.json> [IDS|--dry-run]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mutlib import Mutant, run  # noqa: E402

T = ["apps/arena-engine/tests/md-replay-v2.test.ts"]
B = "apps/arena-engine/src/sim/battle.ts"
R = "apps/arena-engine/src/replay.ts"
G = "apps/arena-engine/src/rng.ts"


def rx(id_, desc, path, old, new, filt):
    return Mutant(id_, desc, path, old, new, T, name_filter=filt, regex=True)


def lit(id_, desc, path, old, new, filt):
    return Mutant(id_, desc, path, old, new, T, name_filter=filt)


MUTANTS = [
    rx("M01", "verify sin winner", R, r'^[ \t]*cmp\("winner"[^\n]*\n', "", "winner falsificado"),
    rx("M02", "verify sin endReason", R, r'^[ \t]*cmp\("endReason"[^\n]*\n', "", "endReason falsificado"),
    rx("M03", "verify sin score", R, r'^[ \t]*cmp\("score"[^\n]*\n', "", "score falsificado"),
    rx("M04", "verify sin disqualified", R, r'cmp\(\s*"disqualified",.*?\n  \);', "", "disqualified falsificado"),
    lit("M05", "hash sin entitySeq", B, "nextSeq: this.entitySeq", "nextSeq: 0", "entitySeq"),
    lit("M06", "RNG con nombre compartido", G,
        "this.streams.set(name, Rng.fromState(deriveStreamState(seed, name)))",
        'this.streams.set(name, (this as any).shared ??= Rng.fromState(deriveStreamState(seed, "combat")))',
        "DISTINTOS"),
    lit("M07", "hash sin respawnAtTick", B, 'new Set(["spec"])', 'new Set(["spec", "respawnAtTick"])',
        "respawnAtTick"),
    lit("M08", "hash sin pendingCommands", B, "pendingCommands: this.pendingLatencyCommands",
        "pendingCommands: []", "comandos en vuelo"),
    lit("M09", "hash sin cola de radio", B, "radio: this.radioQueue,", "radio: [],", "cola de radio"),
    # G1: ancla INEQUÍVOCA (sitio del hash). `projectiles: this.projectiles,` sola está dos veces.
    lit("M10", "hash de proyectil v1 (sin TTL/owner/velocidad)", B,
        "      projectiles: this.projectiles,\n      deployables: this.mines,\n",
        "      projectiles: this.projectiles.map((p) => [p.id, p.position.x, p.position.y, p.damage]),\n"
        "      deployables: this.mines,\n",
        "TTL de proyectil"),
    lit("M11", "hash de mina v1 (sin armado/owner)", B,
        "      projectiles: this.projectiles,\n      deployables: this.mines,\n",
        "      projectiles: this.projectiles,\n"
        "      deployables: this.mines.map((m) => [m.id, m.position.x, m.position.y]),\n",
        "armado de mina"),
    lit("M12", "observationFor consume el RNG canónico", B, 'this.rng.stream("sensors").clone()',
        'this.rng.stream("sensors")', "NO consume RNG"),
    lit("M13", "verify ignora los checkpoints", R, "if (ck.mismatch) mismatches.push(ck.mismatch);", "",
        "checkpoint adulterado ⇒ no verifica"),
    lit("M14", "compareCheckpoints devuelve el índice equivocado", R, "return extra.tick;", "return n;",
        "longitudes distintas"),
    lit("M15", "verify sin comprobación del catálogo", R,
        "if (h.catalog?.specDigest !== participantsSpecDigest(h.participants ?? [])) {", "if (false) {",
        "catálogo \\(specs\\)"),
    lit("M16", "hash sin teamKills", B, "teamKills: this.teamKills", "teamKills: {}", "teamKills"),
    lit("M17", "verify sin comprobación de runtime", R, "if (h.runtime !== currentRuntime()) return",
        "if (false) return", "cambio de runtime"),
    lit("M18", "hash sin RNG", B, "rng: this.rng.getState(),", "rng: [],", "flujo RNG combat"),
    lit("M19", "latencia simulada en el flujo combat", B, 'this.rng.stream("latency").int',
        'this.rng.stream("combat").int', "latencia simulada"),
    lit("M20", "verify no reproduce las cadencias", R, "hashEveryNTicks: h.cadences?.hashEveryNTicks,", "",
        "cadencia de hash NO"),
    lit("M21", "checkpoint: components sin validar contra el hash", R,
        "if (hashFromComponents(o.components) !== o.hash) {", "if (false) {", "hash INTACTO"),
    rx("M22", "observationFor sin guarda en batalla grabada", B,
       r'if \(this\.config\.recordReplay\) \{(\s*throw new Error\(\s*"observationFor)', r"if (false) {\1",
       "batalla GRABADA"),
]

if __name__ == "__main__":
    run("md", MUTANTS, sys.argv)
