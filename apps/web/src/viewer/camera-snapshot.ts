/**
 * R3.3 · ERR-VIS-09 — Cuaderno REUTILIZABLE para alimentar a computeCamera.
 *
 * `applyCamera` construía en CADA frame un objeto `snapshotLike` con un array
 * nuevo y un objeto por vehículo (más el `[...map.entries()].map(...)`): a 60 fps
 * con 8 bots son cientos de asignaciones por segundo sólo para calcular el
 * encuadre. Este cuaderno asigna el array, el objeto contenedor y un objeto por
 * id UNA vez y los rellena en el sitio; el snapshot devuelto es válido hasta la
 * siguiente llamada `fill` del MISMO cuaderno (el consumidor es computeCamera,
 * que lo lee y lo suelta dentro del mismo frame).
 *
 * Es PURO (no toca Phaser): se prueba con vitest comprobando que las referencias
 * se reutilizan entre llamadas (proxy observable de "cero asignaciones").
 */

export interface CameraVehicleLike {
  id: string;
  team?: string;
  alive: boolean;
  position: { x: number; y: number };
}

export interface CameraSnapshotLike {
  vehicles: CameraVehicleLike[];
}

/** Pose mínima que el cuaderno necesita de cada vehículo interpolado. */
export interface CameraPose {
  x: number;
  y: number;
  alive: boolean;
  team?: string;
}

export class CameraSnapshotScratch {
  private readonly snapshot: CameraSnapshotLike = { vehicles: [] };
  private readonly cache = new Map<string, CameraVehicleLike>();

  /**
   * Rellena el snapshot con las poses dadas. `teamOf` resuelve el equipo cuando
   * la pose no lo trae (lo conoce el overlay). El array se recorta a la longitud
   * exacta sin crear uno nuevo.
   */
  fill(
    vehicles: Iterable<readonly [string, CameraPose]>,
    teamOf: (id: string) => string | undefined,
  ): CameraSnapshotLike {
    const out = this.snapshot;
    let n = 0;
    for (const [id, pose] of vehicles) {
      let v = this.cache.get(id);
      if (!v) {
        v = { id, team: undefined, alive: true, position: { x: 0, y: 0 } };
        this.cache.set(id, v);
      }
      v.team = pose.team ?? teamOf(id);
      v.alive = pose.alive;
      v.position.x = pose.x;
      v.position.y = pose.y;
      out.vehicles[n] = v;
      n++;
    }
    out.vehicles.length = n;
    return out;
  }
}
