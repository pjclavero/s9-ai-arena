#!/usr/bin/env bash
# PREFLIGHT DE APAGADO DE VM108 · solo lectura, no toca nada.
#
# Responde a una sola pregunta: ¿se puede apagar ahora mismo sin perder trabajo?
#
# Lo que se pierde en un apagado no son los datos —viven en volúmenes— sino el trabajo a
# medias: un job reclamado que nadie devolverá a la cola, una batalla en curso con su
# contenedor efímero, una transacción abierta. Por eso el preflight mira estado en vuelo,
# no espacio en disco.
#
# Salida: rc=0 si es seguro apagar, rc=1 si hay algo en vuelo, rc=2 si no se pudo comprobar
# (que NO es lo mismo que «seguro»: una comprobación que no se pudo hacer nunca es un visto
# bueno).
#
# Uso:  bash infrastructure/scripts/preflight-apagado.sh
set -uo pipefail

PROYECTO=${COMPOSE_PROJECT_NAME:-infrastructure}
PG=${PG_CONTAINER:-${PROYECTO}-postgres-1}
Q=${QUEUE_CONTAINER:-${PROYECTO}-queue-1}
BK=${BACKUP_CONTAINER:-${PROYECTO}-backup-1}

BLOQUEOS=0
NO_COMPROBADO=0

titulo() { printf '\n=== %s ===\n' "$1"; }
bloquea() { printf '  BLOQUEA · %s\n' "$1"; BLOQUEOS=$((BLOQUEOS + 1)); }
nocomp() { printf '  NO COMPROBADO · %s\n' "$1"; NO_COMPROBADO=$((NO_COMPROBADO + 1)); }

sql() { # $1 = consulta; imprime el valor o vacío si falla
  docker exec "$PG" psql -U arena -d arena -tAc "$1" 2>/dev/null | tr -d ' \n'
}

titulo "1 · trabajo en vuelo"
JOBS=$(sql "select count(*) from jobs where status in ('running','claimed','pending')")
if [ -z "$JOBS" ]; then nocomp "no se pudo consultar la tabla jobs"; else
  echo "  jobs running/claimed/pending: $JOBS"
  [ "$JOBS" = "0" ] || bloquea "hay $JOBS job(s) en vuelo: se quedarían reclamados sin dueño"
fi
BATALLAS=$(sql "select count(*) from battles where status='running'")
if [ -z "$BATALLAS" ]; then nocomp "no se pudo consultar la tabla battles"; else
  echo "  batallas running: $BATALLAS"
  [ "$BATALLAS" = "0" ] || bloquea "hay $BATALLAS batalla(s) en curso"
fi
BUILDS=$(sql "select count(*) from builds where status in ('running','pending','queued')")
if [ -z "$BUILDS" ]; then nocomp "no se pudo consultar la tabla builds"; else
  echo "  builds en curso: $BUILDS"
  [ "$BUILDS" = "0" ] || bloquea "hay $BUILDS build(s) en curso"
fi

titulo "2 · transacciones abiertas en PostgreSQL"
IDLE=$(sql "select count(*) from pg_stat_activity where datname='arena' and state like 'idle in transaction%'")
PREP=$(sql "select count(*) from pg_prepared_xacts")
if [ -z "$IDLE" ] || [ -z "$PREP" ]; then nocomp "no se pudo consultar pg_stat_activity"; else
  echo "  idle in transaction: $IDLE   ·   prepared (2PC): $PREP"
  [ "$IDLE" = "0" ] || bloquea "$IDLE transacción(es) abierta(s) sin confirmar"
  [ "$PREP" = "0" ] || bloquea "$PREP transacción(es) preparada(s) 2PC pendientes"
fi

titulo "3 · contenedores efímeros de batalla"
TOTAL=$(docker ps -q 2>/dev/null | wc -l)
DEL_PROYECTO=$(docker ps --filter "label=com.docker.compose.project=$PROYECTO" -q 2>/dev/null | wc -l)
echo "  del proyecto: $DEL_PROYECTO   ·   totales en el host: $TOTAL"
AJENOS=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -v "^${PROYECTO}-" || true)
if [ -n "$AJENOS" ]; then
  echo "$AJENOS" | sed 's/^/    ajeno: /'
  bloquea "hay contenedores fuera del stack (¿batalla en curso?)"
else
  echo "  ninguno ajeno"
fi

titulo "4 · la cola es efímera, pero se comprueba"
DB=$(docker exec "$Q" redis-cli DBSIZE 2>/dev/null | tr -d ' \r\n')
if [ -z "$DB" ]; then nocomp "no se pudo consultar Redis"; else
  echo "  DBSIZE: $DB"
  [ "$DB" = "0" ] || echo "  AVISO · $DB clave(s) en la cola; está clasificada EPHEMERAL, pero míralo"
fi

titulo "5 · red de seguridad: último backup con BD"
docker exec "$BK" sh -lc 'restic snapshots --json 2>/dev/null' > /tmp/preflight-snaps.json 2>/dev/null
if [ ! -s /tmp/preflight-snaps.json ]; then
  nocomp "no se pudo listar snapshots de restic"
else
  python3 - <<'PY' || true
import json, datetime
s = json.load(open('/tmp/preflight-snaps.json'))
st = sorted([x for x in s if any('staging' in p for p in x.get('paths', []))],
            key=lambda d: d.get('time', ''))
if not st:
    print("  AVISO · ningún snapshot con la BD")
else:
    u = st[-1]; t = u['time'][:19]
    try:
        h = (datetime.datetime.utcnow() - datetime.datetime.fromisoformat(t)).total_seconds() / 3600
        print(f"  último: {u['short_id']}  {t}Z  (hace {h:.1f} h)")
        if h > 48:
            print(f"  AVISO · la copia tiene {h:.0f} h")
    except Exception:
        print(f"  último: {u['short_id']}  {t}Z")
print(f"  snapshots totales: {len(s)}")
PY
fi

titulo "6 · ventana del backup programado"
CRON=$(docker exec "$BK" sh -lc 'crontab -l 2>/dev/null | grep -v "^#" | head -3' 2>/dev/null)
if [ -z "$CRON" ]; then nocomp "no se pudo leer el crontab del contenedor de backup"; else
  echo "$CRON" | sed 's/^/  /'
  echo "  hora actual (UTC): $(date -u +%H:%M)"
  echo "  (si la VM sigue apagada a esa hora, ese día no habrá copia)"
fi

titulo "7 · ¿vuelve solo al encender?"
MALA=0
for C in $(docker ps --filter "label=com.docker.compose.project=$PROYECTO" --format '{{.Names}}' 2>/dev/null); do
  P=$(docker inspect "$C" --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null)
  case "$P" in
    unless-stopped | always) ;;
    *) echo "  !!! $C tiene restart=$P"; MALA=$((MALA + 1)) ;;
  esac
done
[ "$MALA" -eq 0 ] && echo "  los $DEL_PROYECTO contenedores arrancan solos (unless-stopped/always)" \
                  || bloquea "$MALA contenedor(es) no arrancarían solos"
echo -n "  docker habilitado en el arranque: "
systemctl is-enabled docker 2>/dev/null || nocomp "no se pudo leer el estado de systemd"

titulo "VEREDICTO"
if [ "$BLOQUEOS" -gt 0 ]; then
  echo "  NO APAGAR · $BLOQUEOS motivo(s) de bloqueo"
  exit 1
fi
if [ "$NO_COMPROBADO" -gt 0 ]; then
  echo "  INDETERMINADO · $NO_COMPROBADO comprobación(es) no se pudieron hacer."
  echo "  Una comprobación que no se pudo hacer NO es un visto bueno."
  exit 2
fi
echo "  SEGURO APAGAR · sin trabajo en vuelo, sin transacciones abiertas, todo vuelve solo"
exit 0
