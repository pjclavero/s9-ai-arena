/**
 * V1 REPLAYS PR-4 · Todas las instantáneas de un replay leyendo la API por SEGMENTOS (como el
 * reproductor). Un segmento abarca como mucho 1200 ticks (400 `segment_range_too_large` si no) y
 * arranca en el keyframe anterior a `fromTick`: los trozos se solapan y se deduplica por tick.
 * Sin dependencias de Playwright: lo usan los specs de navegador y un test de vitest.
 */
export const SEGMENT_CHUNK_TICKS = 1200;

export async function collectReplaySnapshots(
  getSegment: (fromTick: number, toTick: number) => Promise<{ snapshots: any[] }>,
  ticks: number,
): Promise<any[]> {
  const byTick = new Map<number, any>();
  for (let from = 0; from <= ticks; from += SEGMENT_CHUNK_TICKS) {
    const to = Math.min(from + SEGMENT_CHUNK_TICKS - 1, ticks);
    const seg = await getSegment(from, to);
    for (const s of seg.snapshots) if (!byTick.has(s.tick)) byTick.set(s.tick, s);
  }
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}
