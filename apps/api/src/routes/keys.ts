/**
 * R2.5 (ERR-SEC-15) — publicación de la clave PÚBLICA de firma de artefactos.
 *
 * Extensión documentada fuera del contrato de E1 (como recoverAccount/resetPassword):
 * cualquier verificador (motor, worker de batallas, terceros) obtiene aquí la clave
 * con la que comprobar las firmas ed25519 de los artefactos. Solo se expone la
 * PÚBLICA, derivada de la privada del almacén de secretos.
 *
 * Fallar cerrado: si la clave de firma no está configurada (y no es el modo dev
 * explícito), el endpoint responde 503 — nunca inventa una clave.
 */
import { Router } from "express";
import { defineExtension } from "../registry.js";
import { ApiError } from "../errors.js";
import { loadServiceKeypair, publicKeyPem } from "../../../bot-manager/src/signing.js";

export function keyRoutes(): Router {
  const router = Router();
  defineExtension(
    router,
    { operationId: "getSigningPublicKey", method: "get", path: "/keys/artifact-signing", minRole: "visitor" },
    async (_req, res) => {
      let pem: string;
      try {
        pem = publicKeyPem(loadServiceKeypair().publicKey);
      } catch (e) {
        throw new ApiError(
          503,
          "signing_key_unavailable",
          `Clave de firma de artefactos no configurada: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      res.json({ algorithm: "ed25519", format: "spki-pem", publicKeyPem: pem });
    },
  );
  return router;
}
