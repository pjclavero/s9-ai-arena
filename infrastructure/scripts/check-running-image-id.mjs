#!/usr/bin/env node
/**
 * ADR-016 · DRIFT CRÍTICO: la image ID en ejecución ya no existe en el daemon.
 *
 * Segundo incidente real: un contenedor de producción seguía corriendo una
 * image ID que había sido BORRADA del daemon. `docker inspect <contenedor>`
 * la reportaba tan tranquilo (el contenedor vive sobre sus capas), pero
 * `docker image inspect <id>` decía "No such image". Consecuencia: ese estado
 * NO era reproducible tras un restart y el baseline no servía para rollback —
 * y nadie lo veía, porque nada lo miraba.
 *
 * Este script mira. Para cada contenedor en marcha compara su `.Image` (la ID
 * de contenido sobre la que corre) con el inventario de imágenes del daemon.
 *
 * Uso:
 *   node infrastructure/scripts/check-running-image-id.mjs            # daemon real
 *   node infrastructure/scripts/check-running-image-id.mjs --self-test # calibración
 *
 * rc=0 todas las imágenes en ejecución existen · rc=1 DRIFT CRÍTICO.
 */
import { spawnSync } from "node:child_process";

/**
 * Núcleo puro: contenedores {nombre, imageId, etiqueta} contra el conjunto de
 * IDs que el daemon conoce. Devuelve los contenedores huérfanos.
 */
export function huerfanos(contenedores, idsExistentes) {
  const conocidas = new Set(idsExistentes);
  return contenedores.filter((c) => !conocidas.has(c.imageId));
}

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  // rc explícito: en una tubería $? es del último comando, nunca del que importa.
  return { rc: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

export function inventarioDelDaemon() {
  const ps = sh("docker", ["ps", "-q"]);
  if (ps.rc !== 0) throw new Error(`docker ps: ${ps.err || "falló"}`);
  const contenedores = ps.out
    .split("\n")
    .filter(Boolean)
    .map((id) => {
      const i = sh("docker", ["inspect", "-f", "{{.Name}}\t{{.Image}}\t{{.Config.Image}}", id]);
      if (i.rc !== 0) throw new Error(`docker inspect ${id}: ${i.err || "falló"}`);
      const [nombre, imageId, etiqueta] = i.out.split("\t");
      return { nombre, imageId, etiqueta };
    });

  const imgs = sh("docker", ["images", "--no-trunc", "-q"]);
  if (imgs.rc !== 0) throw new Error(`docker images: ${imgs.err || "falló"}`);
  return { contenedores, ids: imgs.out.split("\n").filter(Boolean) };
}

/**
 * Calibración: el detector tiene que poder ponerse ROJO. Se le da un caso
 * fabricado con una image ID que el daemon no conoce (control negativo) y otro
 * coherente (control positivo). Si el negativo no dispara, el detector no
 * detecta nada y este script falla aquí, no en producción seis meses después.
 */
function autoprueba() {
  const idViva = "sha256:" + "a".repeat(64);
  const idBorrada = "sha256:" + "b".repeat(64);
  const contenedores = [
    { nombre: "/sano", imageId: idViva, etiqueta: "s9-ai-arena/api:sha-nuevo" },
    { nombre: "/derivado", imageId: idBorrada, etiqueta: "s9-ai-arena/replay-service:sha-nuevo" },
  ];

  const positivo = huerfanos([contenedores[0]], [idViva]);
  if (positivo.length !== 0) {
    console.error("autoprueba: el control POSITIVO falló — marca huérfano lo que sí existe");
    return 1;
  }
  const negativo = huerfanos(contenedores, [idViva]);
  if (negativo.length !== 1 || negativo[0].nombre !== "/derivado") {
    console.error("autoprueba: el control NEGATIVO no disparó — el detector NO detecta el incidente real");
    return 1;
  }
  console.log("autoprueba OK · el detector de image ID huérfana se pone rojo cuando debe (positivo y negativo)");
  return 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return autoprueba();

  const { contenedores, ids } = inventarioDelDaemon();
  const sueltos = huerfanos(contenedores, ids);
  if (sueltos.length > 0) {
    console.error("DRIFT CRÍTICO · contenedores corriendo sobre una image ID que ya NO existe en el daemon:");
    for (const c of sueltos) {
      console.error(`  ✗ ${c.nombre} (etiqueta declarada: ${c.etiqueta})`);
    }
    console.error(
      "El estado actual NO es reproducible: un restart no lo recupera y el baseline no sirve para rollback. " +
        "Reconstruir o volver a bajar la imagen del registro ANTES de tocar nada.",
    );
    return 1;
  }
  console.log(`OK · las ${contenedores.length} imágenes en ejecución existen en el daemon`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
