import { describe, it, expect } from "vitest";
import { packArtifact } from "../src/artifact.js";
import { generateServiceKeypair, signArtifact, verifyArtifact } from "../src/signing.js";
import { pyGoodFiles } from "./fixtures.js";

describe("T6.1 · firma y verificación del artefacto", () => {
  it("un artefacto firmado se verifica antes de ejecutar", () => {
    const kp = generateServiceKeypair();
    const artifact = packArtifact(pyGoodFiles());
    const sig = signArtifact(artifact.hash, kp.privateKey);
    const res = verifyArtifact({ artifactBytes: artifact.bytes, signedHash: artifact.hash, signature: sig, publicKey: kp.publicKey });
    expect(res.ok).toBe(true);
  });

  it("un artefacto MANIPULADO se rechaza (hash no coincide)", () => {
    const kp = generateServiceKeypair();
    const artifact = packArtifact(pyGoodFiles());
    const sig = signArtifact(artifact.hash, kp.privateKey);
    const tampered = Buffer.concat([artifact.bytes, Buffer.from("evil")]);
    const res = verifyArtifact({ artifactBytes: tampered, signedHash: artifact.hash, signature: sig, publicKey: kp.publicKey });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/manipulado/);
  });

  it("una firma de otra clave se rechaza", () => {
    const kp = generateServiceKeypair();
    const attacker = generateServiceKeypair();
    const artifact = packArtifact(pyGoodFiles());
    const sig = signArtifact(artifact.hash, attacker.privateKey);
    const res = verifyArtifact({ artifactBytes: artifact.bytes, signedHash: artifact.hash, signature: sig, publicKey: kp.publicKey });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/firma/);
  });
});
