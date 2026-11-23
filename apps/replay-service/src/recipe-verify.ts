/**
 * V1 REPLAYS PR-4 · verify() del motor sobre una RECETA S9R/1 en disco, leída por fragmentos
 * (RecipeCursor): misma decisión que `verify()` (cabecera, hashes intermedios, checkpoints por
 * componente y resultado completo) sin cargar el replay. Lo usan la API (`verifyReplay`) y
 * quien verifica un crudo descargado (CLI, tests).
 */
import { verifyFromSource, type VerifyResult } from "../../arena-engine/src/replay.js";
import { RecipeCursor } from "./s9r/recipe.js";
import type { OpenOptions } from "./s9r/reader.js";

export async function verifyRecipePath(
  path: string,
  opts: OpenOptions = {},
): Promise<{ verification: VerifyResult; header: any; result: any; fragmentReads: number; peakWindowTicks: number }> {
  const cursor = await RecipeCursor.open(path, opts);
  try {
    const verification = await verifyFromSource(cursor.header, cursor, () => cursor.official());
    return {
      verification,
      header: cursor.header,
      result: cursor.result,
      fragmentReads: cursor.fragmentReads,
      peakWindowTicks: cursor.peakWindowTicks,
    };
  } finally {
    await cursor.close();
  }
}
