// @vitest-environment jsdom
/**
 * UX-F (DEF-R2) · el borrador del editor es de UNA cuenta. Antes la clave era
 * global (`s9_draft:bots:upload:code`) y «Salir» no borraba `sessionStorage`: la
 * cuenta B veía en la misma pestaña lo que A dejó escrito.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DRAFT_PREFIX, clearAllDrafts, setDraftOwner, useSessionDraft } from "../src/ui/draft.js";
import { logout } from "../src/api.js";

function draftKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (k && k.startsWith(DRAFT_PREFIX)) out.push(k);
  }
  return out;
}

beforeEach(() => {
  sessionStorage.clear();
  clearAllDrafts();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DEF-R2 · borradores aislados por cuenta", () => {
  it("la clave lleva el id del usuario", () => {
    setDraftOwner("user-a");
    const { result } = renderHook(() => useSessionDraft("bots:upload:code", "plantilla"));
    act(() => result.current.setValue("SECRETO-DE-A"));
    expect(draftKeys()).toEqual([`${DRAFT_PREFIX}user-a:bots:upload:code`]);
  });

  it("B no recupera lo que A escribió (cambio de usuario en la misma pestaña)", () => {
    setDraftOwner("user-a");
    const a = renderHook(() => useSessionDraft("bots:upload:code", "plantilla"));
    act(() => a.result.current.setValue("SECRETO-DE-A"));
    a.unmount();

    setDraftOwner("user-b");
    expect(draftKeys()).toEqual([]); // los de A se borran al entrar otra cuenta
    const b = renderHook(() => useSessionDraft("bots:upload:code", "plantilla"));
    expect(b.result.current.value).toBe("plantilla");
    expect(b.result.current.restored).toBe(false);
  });

  it("«Salir» borra todas las claves s9_draft:*", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    setDraftOwner("user-a");
    const a = renderHook(() => useSessionDraft("bots:upload:code", "plantilla"));
    act(() => a.result.current.setValue("SECRETO-DE-A"));
    sessionStorage.setItem(`${DRAFT_PREFIX}huerfano`, "x"); // formato antiguo, sin usuario
    await logout();
    expect(draftKeys()).toEqual([]);
  });

  it("sesión caducada y vuelve el MISMO usuario: el borrador se recupera (UX-E)", () => {
    setDraftOwner("user-a");
    const a = renderHook(() => useSessionDraft("bots:upload:code", "plantilla"));
    act(() => a.result.current.setValue("mis cambios"));
    a.unmount(); // el App desmonta el panel al caducar la sesión

    setDraftOwner("user-a");
    const again = renderHook(() => useSessionDraft("bots:upload:code", "plantilla"));
    expect(again.result.current.value).toBe("mis cambios");
    expect(again.result.current.restored).toBe(true);
  });
});
