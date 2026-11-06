import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const kb of [32, 64, 72, 80, 96, 128, 256]) {
  const dir = mkdtempSync(join(tmpdir(), "s9-thr-"));
  const m = join(dir, "m");
  const p = spawn("sh", ["-c", `head -c ${kb * 1024} /dev/zero | tr '\\0' x >&2; touch ${m}; exec sleep 30`], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  for (let i = 0; i < 50 && !existsSync(m); i++) await sleep(20);
  console.log(`${kb} KiB -> ${existsSync(m) ? "avanza" : "BLOQUEADO"}`);
  try {
    process.kill(-p.pid, "SIGKILL");
  } catch {}
}
process.exit(0);
