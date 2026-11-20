#!/usr/bin/env bash
# TD-064 · mutantes de init-secrets.sh. Cada mutante rompe UNA defensa del
# script y debe ser MATADO por un test concreto y nombrado de
# init-secrets-nofollow.test.ts (INIT_SECRETS_UNDER_TEST apunta al mutante).
# Línea base: el script real en verde. Uso (desde la raíz del repo, en VM111):
#   bash infrastructure/tests/init-secrets-mutations.sh
# Commitea antes de lanzarlo; no modifica el árbol (trabaja en un directorio temporal).
set -uo pipefail
case "$(hostname)" in ia-server) echo "STOP: sólo en VM111"; exit 1 ;; esac
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SRC="$REPO/infrastructure/scripts/init-secrets.sh"
TEST=infrastructure/tests/init-secrets-nofollow.test.ts
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT
WORKERS=${MAXWORKERS:-1}

# ROOT_CONTAINER=1: los escenarios de root se ejecutan con root REAL en un contenedor
# desechable sin red (VM111 no tiene user namespaces) y el test consume su salida.
# Sin eso, los mutantes que sólo mueren con root real sobreviven en VM111 (test omitido).
runtest() { # $1 = script bajo prueba -> JSON en $2
  local rootenv=()
  if [ "${ROOT_CONTAINER:-0}" = 1 ]; then
    bash "$REPO/infrastructure/tests/init-secrets-root-container.sh" "$1" "$2.root" >/dev/null
    rootenv=(INIT_SECRETS_ROOT_OUTPUT="$2.root")
  fi
  (cd "$REPO" && env "${rootenv[@]}" INIT_SECRETS_UNDER_TEST="$1" npx vitest run "$TEST" --maxWorkers="$WORKERS" \
    --reporter=json --outputFile="$2" >/dev/null 2>&1)
  echo $?
}
failed_names() { python3 -I - "$1" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for f in d["testResults"]:
    for a in f["assertionResults"]:
        if a["status"]=="failed": print(a["title"])
PY
}
mutate() { # $1 id, $2 exacto-a-reemplazar, $3 sustituto -> $W/$1.sh
  python3 -I - "$SRC" "$W/$1.sh" "$2" "$3" <<'PY'
import sys
src=open(sys.argv[1]).read(); old=sys.argv[3]; new=sys.argv[4]
if src.count(old)!=1:
    sys.exit("mutante mal definido: %d apariciones de %r" % (src.count(old), old))
open(sys.argv[2],"w").write(src.replace(old,new))
PY
}

# ONLY=M3 ejecuta un único mutante (y NO la línea base: ejecútala antes con ONLY=BASE);
# permite al orquestador comprobar la presión del host antes de cada ejecución.
ONLY=${ONLY:-}
if [ -z "$ONLY" ] || [ "$ONLY" = BASE ]; then
  echo "== línea base"
  rc=$(runtest "$SRC" "$W/base.json"); echo "BASE_RC=$rc"
  [ "$rc" = 0 ] || { echo "la línea base no está en verde"; exit 2; }
  [ "$ONLY" = BASE ] && exit 0
fi

fail=0
check() { # id, descripción, subcadena del test que DEBE morir
  local id=$1 desc=$2 want=$3 rc names
  [ -z "$ONLY" ] || [ "$ONLY" = "$id" ] || return 0
  rc=$(runtest "$W/$id.sh" "$W/$id.json")
  names=$(failed_names "$W/$id.json" 2>/dev/null || true)
  if [ "$rc" != 0 ] && grep -qF -- "$want" <<<"$names"; then
    echo "MUERTO    $id · $desc  <= «$want»"
  else
    echo "SUPERVIVE $id · $desc (rc=$rc; esperaba que muriera «$want»)"; fail=1
  fi
}

# M1 · lkind sigue enlaces (stat -L): enlaces y colgantes dejan de verse como enlaces
mutate M1 'stat -c '"'"'%F'"'"' -- "$1" 2>/dev/null) || { echo absent' 'stat -L -c '"'"'%F'"'"' -- "$1" 2>/dev/null) || { echo absent' || exit 2
check M1 "lkind sigue enlaces" "jwt_secret.txt -> víctima (gen/harden)"
# M2 · se admiten destinos de enlace con '/' (../../victim)
mutate M2 'case "$t" in ""|.|..|*/*) die' 'case "$t" in ""|.|..) die' || exit 2
check M2 "enlace con '/' admitido" "jwt_secret.txt -> ../../victim (relativo)"
# M3 · se ignoran los hardlinks (nlink > 1)
mutate M3 '[ "$(stat -c '"'"'%h'"'"' -- "$n")" = 1 ] || die "$n tiene enlaces duros (nlink > 1)"' ':' || exit 2
check M3 "sin comprobar nlink" "jwt_secret.txt = hardlink de la víctima"
# M4 · se escribe EN EL SITIO sobre el nombre (abre el nombre final) en vez de rename(2)
mutate M4 'mv -fT -- "$tmp" "${RES:-$n}"' 'cat -- "$tmp" > "${RES:-$n}"; rm -f -- "$tmp"' || exit 2
check M4 "escritura en el sitio en vez de rename" "escritura por rename"
# M5 · secrets/ puede ser un enlace
mutate M5 '*) die "$DIR no es un directorio real (¿enlace?)" ;;' '*) ;;' || exit 2
check M5 "secrets/ como enlace aceptado" "secrets/ sustituido por un enlace a otro directorio"
# M6 · el destino de un enlace admitido no se valida (ni regular ni nlink): un enlace colgante crea el destino
mutate M6 '      [ "$(lkind "$t")" = file ] || die "$n -> $t: el destino no es un fichero regular existente"
      [ "$(stat -c '"'"'%h'"'"' -- "$t")" = 1 ] || die "$t tiene enlaces duros (nlink > 1)"' '      :' || exit 2
check M6 "destino de enlace sin validar" "enlace con destino literal sin '/' COLGANTE"
# M7 · tls/: se admiten enlaces
mutate M7 'case "$(lkind "$n")" in absent|file) ;; *) die "$n existe y no es un fichero regular" ;; esac' ':' || exit 2
check M7 "tls/ sin comprobar enlaces" "tls/fullchain.pem como enlace colgante"
# M8 · no se aborta ante un enlace no admitido (fail-closed roto)
mutate M8 'exit 3; }' 'return 0 2>/dev/null || true; }' || exit 2
check M8 "die no aborta" "un enlace no admitido aborta con rc != 0"
# M9 · por stdin sin S9_SECRETS_DIR ya no se niega
mutate M9 '[ -n "${BASH_SOURCE[0]:-}" ] || die' ': || die' || exit 2
check M9 "stdin sin directorio permitido" "por stdin sin S9_SECRETS_DIR se niega"
# M10 · los secretos quedan con otro modo (0644)
mutate M10 'chmod 0400 -- "$1"' 'chmod 0644 -- "$1"' || exit 2
check M10 "modo 0644 en vez de 0400" "genera todo en un directorio limpio"
# M11 · root escribe en un directorio ajeno sin ADOPT
mutate M11 'die "$label es de uid $owner: root no escribe' 'echo "$label ajeno tolerado" #' || exit 2
check M11 "root tolera directorio ajeno" "se niega en un dir ajeno"
# M12 · la apropiación no cambia el dueño (el atacante conserva el directorio)
mutate M12 'chown -h 0:0 -- "$d"; chmod 0755 -- "$d"' ':' || exit 2
check M12 "ADOPT sin chown" "se niega en un dir ajeno"
# M13 · un enlace admitido deja de respetarse (se rechaza todo enlace)
mutate M13 '[ "$lo" = 0 ] || [ "$lo" = "$ME" ] || die' '[ "$lo" = 9999 ] || die' || exit 2
check M13 "enlace admitido rechazado" "respeta el enlace admitido restic_ssh_key"

# ---- ronda 2 (revisión del PR #169): bloque stream_secrets y defensas secundarias.
# Los que mueren por root real exigen ROOT_CONTAINER=1 (o un runner con userns).
# M14 · la privada de stream_secrets se escribe con `-out` al nombre final (sigue enlaces)
mutate M14 'rsa_keygen_bits:3072 -out "$t"' 'rsa_keygen_bits:3072 -out "$DIR/stream_secrets_private.pem"' || exit 2
check M14 "stream privada escrita a través del nombre final" "stream_secrets_private.pem como enlace COLGANTE absoluto"
# M15 · la pública de stream_secrets vuelve al .tmp predecible
mutate M15 '-in "$SIGN2" -pubout -out "$t" 2>/dev/null; then' '-in "$SIGN2" -pubout -out "$DIR/stream_secrets_public.pem.tmp" 2>/dev/null && cp -f "$DIR/stream_secrets_public.pem.tmp" "$t"; then' || exit 2
check M15 "stream pública vía .tmp predecible" "stream_secrets_public.pem.tmp -> víctima"
# M16 · el temporal deja de ser exclusivo (nombre predecible, se trunca lo que haya)
mutate M16 'newtmp() { mktemp -- "${1:-}.init-secrets.XXXXXX"; }' 'newtmp() { local p="${1:-}.init-secrets.tmp"; cat /dev/null > "$p"; echo "$p"; }' || exit 2
check M16 "temporal predecible sin O_EXCL" "temporal predecible plantado"
# M17 · (R1 del revisor) tls/ de otro usuario tolerado
mutate M17 'trust_dir tls "$DIR/tls"' ':' || exit 2
check M17 "tls/ sin trust_dir" "con tls/ de otro usuario"
# M18 · (R2) el directorio raíz no se valida
mutate M18 'trust_dir . "$DIR"' ':' || exit 2
check M18 "directorio raíz sin trust_dir" "se niega en un dir ajeno"
# M19 · (R3) el dueño del enlace admitido no se comprueba
mutate M19 '[ "$lo" = 0 ] || [ "$lo" = "$ME" ] || die "$n es un enlace de uid $lo (no admitido)"' ':' || exit 2
check M19 "dueño del enlace sin comprobar" "enlace admitido cuyo dueño es otro uid"
# M20 · (R5) ADOPT deja el directorio 0777
mutate M20 'chown -h 0:0 -- "$d"; chmod 0755 -- "$d"' 'chown -h 0:0 -- "$d"; chmod 0777 -- "$d"' || exit 2
check M20 "ADOPT deja 0777" "carrera: tras apropiarse"
# M21 · (R9) nlink del destino de un enlace admitido sin comprobar
mutate M21 '[ "$(stat -c '"'"'%h'"'"' -- "$t")" = 1 ] || die "$t tiene enlaces duros (nlink > 1)"' ':' || exit 2
check M21 "nlink del destino sin comprobar" "enlace admitido cuyo destino es un hardlink de la víctima"
# M22 · (R14) vuelve el .tmp predecible de artifact_verify_key
mutate M22 'if openssl pkey -in "$SIGN" -pubout -out "$t" 2>/dev/null; then' 'if openssl pkey -in "$SIGN" -pubout -out "$DIR/artifact_verify_key.pem.tmp" 2>/dev/null && cp -f "$DIR/artifact_verify_key.pem.tmp" "$t"; then' || exit 2
check M22 "artifact_verify_key vía .tmp predecible" "artifact_verify_key.pem.tmp -> víctima"
# M23 · H3: se adoptan regulares de otro usuario
mutate M23 '[ "$o" = 0 ] || [ "$o" = "$RUNTIME_UID" ] || die "$1 es de uid' '[ "$o" != x ] || die "$1 es de uid' || exit 2
check M23 "owner_ok no rechaza ajenos" "ADOPT con un fichero regular plantado por otro usuario"
# M24 · H4: sin la comprobación de identidad tras cd -P
mutate M24 '[ "$(dir_id .)" = "$DIR_ID" ] || die' ': || die' || exit 2
check M24 "sin comprobar identidad tras cd -P" "secrets/ sustituido por un enlace ENTRE la comprobación y la entrada"
# M25 · la privada de stream se escribe EN EL SITIO si existe (sin rename)
mutate M25 'mv -fT -- "$tmp" "${RES:-$n}"' 'if [ "$n" = stream_secrets_private.pem ]; then cat -- "$tmp" > "${RES:-$n}"; rm -f -- "$tmp"; else mv -fT -- "$tmp" "${RES:-$n}"; fi' || exit 2
check M25 "stream privada escrita en el sitio" "regular de root con un descriptor abierto antes por el atacante"

echo "== resultado: $([ $fail = 0 ] && echo TODOS_MUERTOS || echo HAY_SUPERVIVIENTES)"
exit $fail
