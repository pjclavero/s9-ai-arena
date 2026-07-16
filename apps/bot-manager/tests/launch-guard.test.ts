import { describe, it, expect } from "vitest";
import { LaunchAuthority, LaunchDenied, type Principal } from "../src/launch-guard.js";

const internal: Principal = { id: "svc:bot-manager", role: "bot-manager-internal" };
const web: Principal = { id: "svc:web", role: "web" };
const publicApi: Principal = { id: "svc:api", role: "public-api" };

describe("T6.2/T6.4 · autorización de lanzamiento de contenedores", () => {
  it("solo el servicio interno bot-manager puede lanzar", () => {
    const auth = new LaunchAuthority();
    expect(() => auth.authorize(internal, "bot_x", 1)).not.toThrow();
    expect(auth.canLaunch(internal, "bot_x")).toBe(true);
  });

  it("la web y la API pública no pueden lanzar contenedores", () => {
    const auth = new LaunchAuthority();
    expect(() => auth.authorize(web, "bot_x")).toThrow(LaunchDenied);
    expect(() => auth.authorize(publicApi, "bot_x")).toThrow(LaunchDenied);
    expect(auth.canLaunch(web, "bot_x")).toBe(false);
  });

  it("un bot suspendido no se lanza aunque el principal sea interno", () => {
    const suspended = new Set(["bot_susp"]);
    const auth = new LaunchAuthority({ isSuspended: (id) => suspended.has(id) });
    expect(() => auth.authorize(internal, "bot_susp", 1)).toThrow(/SUSPENDIDO/);
    expect(auth.canLaunch(internal, "bot_ok")).toBe(true);
  });
});
