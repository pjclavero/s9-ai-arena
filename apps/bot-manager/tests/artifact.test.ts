import { describe, it, expect } from "vitest";
import { packArtifact } from "../src/artifact.js";
import { pyGoodFiles, jsGoodFiles } from "./fixtures.js";

describe("T6.1 · empaquetado reproducible del artefacto", () => {
  it("empaquetar dos veces el mismo fuente Python da el mismo hash", () => {
    const a = packArtifact(pyGoodFiles());
    const b = packArtifact(pyGoodFiles());
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("empaquetar dos veces el mismo fuente JS da el mismo hash", () => {
    const a = packArtifact(jsGoodFiles());
    const b = packArtifact(jsGoodFiles());
    expect(a.hash).toBe(b.hash);
  });

  it("el orden de los ficheros no afecta al hash (empaquetado canónico)", () => {
    const files = pyGoodFiles();
    const reversed = [...files].reverse();
    expect(packArtifact(files).hash).toBe(packArtifact(reversed).hash);
  });

  it("CRLF vs LF no cambian el hash del 'mismo commit'", () => {
    const lf = pyGoodFiles();
    const crlf = lf.map((f) => ({ path: f.path, content: f.content.replace(/\n/g, "\r\n") }));
    expect(packArtifact(lf).hash).toBe(packArtifact(crlf).hash);
  });

  it("un byte distinto en cualquier fichero cambia el hash", () => {
    const base = packArtifact(pyGoodFiles());
    const tampered = pyGoodFiles();
    tampered[tampered.length - 1].content += " ";
    expect(packArtifact(tampered).hash).not.toBe(base.hash);
  });
});
