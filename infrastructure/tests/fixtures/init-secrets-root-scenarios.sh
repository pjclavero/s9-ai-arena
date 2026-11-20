#!/usr/bin/env bash
# TD-064 · escenarios con ROOT y propietarios reales. Se ejecuta como root de un
# user namespace (unshare --map-root-user --map-auto), donde chown a 1000/1002
# funciona de verdad. Uso: init-secrets-root-scenarios.sh <script-bajo-prueba> <tmp>
# Imprime una línea JSON por escenario.
set -u
SUT=$1; BASE=$2
APPUID=1002   # el "s9arena" del escenario: dueño del árbol, sin privilegios

mk() { # árbol de app de uid 1002 con el script de root dentro
  rm -rf "$BASE/t"; mkdir -p "$BASE/t/infrastructure/scripts" "$BASE/t/infrastructure/secrets"
  cp "$SUT" "$BASE/t/infrastructure/scripts/init-secrets.sh"
  chown -R $APPUID:$APPUID "$BASE/t"; chmod 0755 "$BASE/t" "$BASE/t/infrastructure" "$BASE/t/infrastructure/secrets"
  chown 0:0 "$BASE/t/infrastructure/scripts/init-secrets.sh"
  rm -f "$BASE/victim"; printf 'victima\n' > "$BASE/victim"; chown 0:0 "$BASE/victim"; chmod 0644 "$BASE/victim"
}
S() { echo "$BASE/t/infrastructure/secrets"; }
run() { env -u S9_SECRETS_ADOPT "$@" bash "$BASE/t/infrastructure/scripts/init-secrets.sh" >"$BASE/out.log" 2>&1; echo $?; }
vstate() { stat -c '%a %u:%g' "$BASE/victim" 2>/dev/null; sha256sum < "$BASE/victim" | cut -c1-16; }
json() { printf '{"id":"%s","rc":%s,"victim_before":"%s","victim_after":"%s","dir_owner":"%s","files":%s}\n' \
  "$1" "$2" "$(echo $3)" "$(echo $4)" "$(stat -c '%u:%g %a' "$(S)")" "$(find -P "$(S)" -mindepth 1 -maxdepth 1 ! -name '.*' | wc -l)"; }

# R1: dir de s9arena, root sin ADOPT => se niega y no crea nada
mk; b=$(vstate); rc=$(run); json R1-refuse "$rc" "$b" "$(vstate)"

# R2: dir de s9arena, root con ADOPT => se lo apropia y genera
mk; b=$(vstate); rc=$(run S9_SECRETS_ADOPT=1); json R2-adopt "$rc" "$b" "$(vstate)"

# R3: con ADOPT y un enlace plantado por s9arena antes => aborta, víctima intacta
mk; ln -s "$BASE/victim" "$(S)/jwt_secret.txt"; chown -h $APPUID:$APPUID "$(S)/jwt_secret.txt"
b=$(vstate); rc=$(run S9_SECRETS_ADOPT=1); json R3-adopt-planted-link "$rc" "$b" "$(vstate)"

# R4: con ADOPT y artifact_verify_key.pem.tmp -> víctima (vector openssl -out)
mk; ln -s "$BASE/victim" "$(S)/artifact_verify_key.pem.tmp"; chown -h $APPUID:$APPUID "$(S)/artifact_verify_key.pem.tmp"
b=$(vstate); rc=$(run S9_SECRETS_ADOPT=1); json R4-adopt-tmp-link "$rc" "$b" "$(vstate)"

# R5: con ADOPT y enlace a destino inexistente (gen crearía el destino)
mk; rm -f "$BASE/victim"; ln -s "$BASE/victim" "$(S)/replay_ingest_secret.txt"; chown -h $APPUID:$APPUID "$(S)/replay_ingest_secret.txt"
rc=$(run S9_SECRETS_ADOPT=1); a=$(stat -c '%F' "$BASE/victim" 2>/dev/null || echo absent)
printf 'victima\n' > "$BASE/victim"; json R5-adopt-dangling "$rc" "absent" "$a"

# R6: dir de root (estado objetivo) y enlace restic_ssh_key de root admitido
mk; chown 0:0 "$(S)"; printf 'k\n' > "$(S)/s9backup_ssh_key"; chown 1000:1000 "$(S)/s9backup_ssh_key"; chmod 0400 "$(S)/s9backup_ssh_key"
ln -s s9backup_ssh_key "$(S)/restic_ssh_key"; chown -h 0:0 "$(S)/restic_ssh_key"
b=$(vstate); rc=$(run); json R6-root-dir-allowed-link "$rc" "$b" "$(stat -c '%F' "$(S)/restic_ssh_key") $(stat -c '%a %u:%g' "$(S)/s9backup_ssh_key")"

# R7: secrets/ sustituido por un enlace (s9arena controla el padre)
mk; mkdir "$BASE/t/infrastructure/evil"; chown $APPUID:$APPUID "$BASE/t/infrastructure/evil"
rmdir "$(S)"; ln -s evil "$(S)"; chown -h $APPUID:$APPUID "$(S)"
b=$(vstate); rc=$(run S9_SECRETS_ADOPT=1)
printf '{"id":"R7-secrets-is-link","rc":%s,"evil_files":%s}\n' "$rc" "$(find -P "$BASE/t/infrastructure/evil" -mindepth 1 | wc -l)"

# R8: CARRERA. Tras la apropiación (root:root 0755) el antiguo dueño (uid 1002)
# intenta plantar enlaces EN BUCLE mientras root trabaja. Debe fallar siempre
# (EACCES): el directorio ya no es suyo. Víctima intacta, 0 enlaces plantados.
mk; b=$(vstate); rm -f "$BASE/race.try"
chmod 0711 "$BASE"   # el atacante (uid 1002) debe poder ALCANZAR el árbol; si no, la prueba sería vacía
( cd / && setpriv --reuid=$APPUID --regid=$APPUID --clear-groups bash -c '
  end=$((SECONDS+5)); n=0; ok=0
  while [ $SECONDS -lt $end ]; do
    # sólo cuenta intentos DESPUÉS de la apropiación (antes plantar es legítimo y bloquea)
    [ "$(stat -c %u "$2" 2>/dev/null)" = 0 ] || { sleep 0.01; continue; }
    for f in jwt_secret.txt artifact_verify_key.pem.tmp stream_key.txt restic_ssh_known_hosts; do
      n=$((n+1)); ln -sf "$1/victim" "$2/$f" 2>/dev/null && ok=$((ok+1))
    done
  done
  echo "$n $ok"' _ "$BASE" "$(S)" ) > "$BASE/race.try" &
RP=$!
sleep 0.2
rc=$(run S9_SECRETS_ADOPT=1)
wait "$RP"
read -r tries planted < "$BASE/race.try"
printf '{"id":"R8-race-after-adopt","rc":%s,"victim_before":"%s","victim_after":"%s","tries":%s,"planted":%s}\n' \
  "$rc" "$(echo $b)" "$(echo $(vstate))" "$tries" "$planted"

# --- bloque stream_secrets (H1 de la revisión) y defensas secundarias (H2/H3) ---
plant_link() { ln -s "$2" "$(S)/$1"; chown -h $APPUID:$APPUID "$(S)/$1"; }
vgen() { if [ -e "$BASE/victim" ]; then vstate; else echo absent; fi; }

# R9: ADOPT, stream_secrets_public.pem.tmp -> víctima (el nombre antiguo del .tmp)
mk; plant_link stream_secrets_public.pem.tmp "$BASE/victim"; b=$(vstate); rc=$(run S9_SECRETS_ADOPT=1)
json R9-stream-pub-tmp-link "$rc" "$b" "$(vstate)"
# R10: ADOPT, stream_secrets_private.pem colgante (la clave privada se crearía fuera)
mk; rm -f "$BASE/victim"; plant_link stream_secrets_private.pem "$BASE/victim"; rc=$(run S9_SECRETS_ADOPT=1)
json R10-stream-priv-dangling "$rc" "absent" "$(vgen)"; printf 'victima\n' > "$BASE/victim"
# R11: ADOPT, stream_secrets_public.pem -> directorio ajeno (el mv depositaría el .tmp dentro)
mk; mkdir "$BASE/vdir"; chown 0:0 "$BASE/vdir"; chmod 0755 "$BASE/vdir"; plant_link stream_secrets_public.pem "$BASE/vdir"
rc=$(run S9_SECRETS_ADOPT=1); printf '{"id":"R11-stream-pub-dir-link","rc":%s,"vdir_files":%s}\n' "$rc" "$(find -P "$BASE/vdir" -mindepth 1 | wc -l)"; rm -rf "$BASE/vdir"
# R12: ADOPT, stream_secrets_private.pem -> víctima VACÍA (se sobrescribiría con la clave)
mk; : > "$BASE/victim"; plant_link stream_secrets_private.pem "$BASE/victim"; b=$(vstate); rc=$(run S9_SECRETS_ADOPT=1)
json R12-stream-priv-empty-victim "$rc" "$b" "$(vstate)"; printf 'victima\n' > "$BASE/victim"
# R13: ADOPT, fichero REGULAR vacío plantado por el atacante con un descriptor abierto
# antes. El atacante lo conserva abierto mientras corre root; después lee por ese fd.
leak() { # $1 = fichero ya plantado; deja en $BASE/leak los bytes que el atacante lee por su fd
  rm -f "$BASE/ready" "$BASE/done" "$BASE/leak"
  ( cd / && setpriv --reuid=$APPUID --regid=$APPUID --clear-groups bash -c '
    exec 3<"$1"; : > "$2/ready"
    while [ ! -e "$2/done" ]; do sleep 0.05; done
    wc -c <&3 > "$2/leak"' _ "$1" "$BASE" ) &
  LP=$!
  for _ in $(seq 100); do [ -e "$BASE/ready" ] && break; sleep 0.05; done
}
chmod 0711 "$BASE"
mk; : > "$(S)/stream_secrets_private.pem"; chown $APPUID:$APPUID "$(S)/stream_secrets_private.pem"; chmod 0600 "$(S)/stream_secrets_private.pem"
leak "$(S)/stream_secrets_private.pem"; rc=$(run S9_SECRETS_ADOPT=1); : > "$BASE/done"; wait "$LP"
printf '{"id":"R13-stream-priv-planted-fd","rc":%s,"leaked":%s}\n' "$rc" "$(cat "$BASE/leak")"
# R14: igual, pero el fichero ya es de root cuando corre el script (el fd del atacante
# se abrió antes del chown): se debe SUSTITUIR por rename, no escribir en el sitio.
mk; : > "$(S)/stream_secrets_private.pem"; chown $APPUID:$APPUID "$(S)/stream_secrets_private.pem"; chmod 0644 "$(S)/stream_secrets_private.pem"
leak "$(S)/stream_secrets_private.pem"; chown 0:0 "$(S)/stream_secrets_private.pem"; rc=$(run S9_SECRETS_ADOPT=1); : > "$BASE/done"; wait "$LP"
printf '{"id":"R14-stream-priv-rootowned-fd","rc":%s,"leaked":%s,"final_size_gt0":%s}\n' "$rc" "$(cat "$BASE/leak")" \
  "$([ -s "$(S)/stream_secrets_private.pem" ] && echo true || echo false)"
# R15 (H2/R1): secrets/ de root pero tls/ de otro usuario, sin ADOPT => se niega
mk; chown 0:0 "$(S)"; mkdir "$(S)/tls"; chown $APPUID:$APPUID "$(S)/tls"; chmod 0755 "$(S)/tls"
rc=$(run); printf '{"id":"R15-tls-foreign-owner","rc":%s,"files":%s}\n' "$rc" "$(find -P "$(S)" -mindepth 1 -maxdepth 1 ! -name tls | wc -l)"
# R16 (H2/R3): dir de root, enlace restic_ssh_key de OTRO uid -> destino de uid 1000: se niega
mk; chown 0:0 "$(S)"; printf 'k\n' > "$(S)/s9b"; chown 1000:1000 "$(S)/s9b"; chmod 0644 "$(S)/s9b"
ln -s s9b "$(S)/restic_ssh_key"; chown -h $APPUID:$APPUID "$(S)/restic_ssh_key"
rc=$(run); printf '{"id":"R16-link-foreign-owner","rc":%s,"target_mode":"%s"}\n' "$rc" "$(stat -c '%a' "$(S)/s9b")"
# R17 (H3): ADOPT con un REGULAR plantado por otro usuario (secreto conocido) => se rechaza
mk; printf 'conocido\n' > "$(S)/jwt_secret.txt"; chown $APPUID:$APPUID "$(S)/jwt_secret.txt"
rc=$(run S9_SECRETS_ADOPT=1); printf '{"id":"R17-adopt-foreign-regular","rc":%s,"content":"%s","owner":"%s"}\n' "$rc" "$(cat "$(S)/jwt_secret.txt")" "$(stat -c %u "$(S)/jwt_secret.txt")"

# Limpieza DENTRO del namespace o contenedor: fuera, los ficheros de subuids no se pueden borrar.
rm -rf "$BASE/t" "$BASE/victim" "$BASE/out.log"
