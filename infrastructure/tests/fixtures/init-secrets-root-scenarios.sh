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

# Limpieza DENTRO del namespace: fuera, los ficheros de subuids no se pueden borrar.
rm -rf "$BASE/t" "$BASE/victim" "$BASE/out.log"
