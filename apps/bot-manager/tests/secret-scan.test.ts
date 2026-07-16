import { describe, it, expect } from "vitest";
import { scanSecrets } from "../src/secret-scan.js";
import { pyGoodFiles, pySecretFiles } from "./fixtures.js";

describe("T6.4 · escaneo de secretos", () => {
  it("un bot limpio no produce hallazgos", () => {
    expect(scanSecrets(pyGoodFiles())).toHaveLength(0);
  });

  it("detecta una clave AWS de ejemplo con fichero y línea", () => {
    const matches = scanSecrets(pySecretFiles());
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].kind).toBe("aws_access_key_id");
    expect(matches[0].file).toBe("src/bot.py");
    expect(matches[0].line).toBe(1);
    // nunca vuelca el secreto entero
    expect(matches[0].excerpt).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });

  it("detecta tokens de GitHub, private keys y contraseñas hardcodeadas", () => {
    const files = [
      { path: "a.py", content: "token = 'ghp_" + "a".repeat(36) + "'" },
      { path: "b.py", content: "-----BEGIN RSA PRIVATE KEY-----" },
      { path: "c.py", content: "password = 'hunter2secret'" },
    ];
    const kinds = scanSecrets(files).map((m) => m.kind);
    expect(kinds).toContain("github_token");
    expect(kinds).toContain("private_key_block");
    expect(kinds).toContain("hardcoded_password");
  });
});
