/**
 * EQ3 · Ayuda contextual «ⓘ» reutilizable (Centro de Ayuda integrado).
 *
 * Un botón pequeño junto a un control (slot de loadout, módulo, modo, respawns,
 * rating, V-D-E, elemento del editor, regla…) que abre un POPOVER no modal con
 * una explicación corta y, opcionalmente, un enlace a la sección del Centro de
 * Ayuda (`#/help/...`). Requisitos del encargo y cómo se cumplen:
 *
 *  - abre un popover: `<button aria-expanded aria-controls>` + panel
 *    `role="dialog"` NO modal (sin `aria-modal`, sin fondo, sin trampa de foco):
 *    no bloquea la pantalla;
 *  - se cierra con la X (botón «Cerrar ayuda»), con Escape y al pulsar/tocar
 *    fuera; al cerrar con X o Escape el foco VUELVE al botón ⓘ;
 *  - todo el marcado es de frase (<span>): se puede poner dentro de <label>,
 *    <p>, <th> o <legend> sin anidar bloques de forma inválida; dentro de un
 *    <label>, un clic en el texto del panel NO activa el label (no alterna su
 *    casilla): se cancela su acción por defecto salvo en enlaces y botones;
 *  - no pierde el estado de los formularios: el disparador es `type="button"`
 *    (nunca envía el `<form>` que lo contiene), el panel se monta junto al botón
 *    sin desmontar nada y Escape no se propaga (no cierra el diálogo o editor
 *    que contenga al ⓘ);
 *  - teclado: Enter/Espacio abre; el foco pasa al panel (se lee su título);
 *    Tab recorre su contenido; salir con Tab fuera del panel lo cierra (también
 *    si el foco cae en <body>, y Escape lo cierra aunque el foco esté fuera);
 *  - móvil: objetivo táctil de 44×44 px y, en pantallas estrechas, el panel es
 *    una hoja fija abajo (sin desbordar ni tapar la pantalla entera).
 *
 * Sin dependencias externas ni red: el contenido viaja con la aplicación.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";

/** Estilos del componente: se inyectan UNA vez en <head> (no se toca index.html). */
export const INFOTIP_CSS = `
.infotip { position: relative; display: inline-block; vertical-align: middle; }
.infotip-trigger {
  background: transparent; color: #7fb4ff; border: 1px solid #3a4658; border-radius: 999px;
  width: 1.5rem; height: 1.5rem; min-width: 1.5rem; padding: 0; margin: 0 0.25rem;
  font: inherit; font-size: 0.85rem; line-height: 1; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.infotip-trigger:hover, .infotip-trigger[aria-expanded="true"] { background: #253041; color: #a9cdff; }
.infotip-panel {
  display: block; position: absolute; z-index: 900; top: calc(100% + 0.35rem); left: 0;
  width: max-content; max-width: min(22rem, calc(100vw - 2rem));
  background: #1a212b; color: #e6e8eb; border: 1px solid #3a4658; border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.45); padding: 0.6rem 0.75rem; text-align: left;
  font-size: 0.92rem; font-weight: normal; white-space: normal;
}
.infotip-panel:focus { outline: 2px solid #7fb4ff; outline-offset: 2px; }
.infotip-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 0.5rem; }
.infotip-title { display: block; margin: 0; font-size: 0.95rem; font-weight: 600; }
.infotip-close {
  background: transparent; color: #e6e8eb; border: 1px solid #3a4658; border-radius: 4px;
  min-width: 1.75rem; height: 1.75rem; padding: 0; line-height: 1; flex: none;
}
.infotip-body { display: block; margin-top: 0.35rem; }
.infotip-body p { margin: 0.3rem 0; }
.infotip-more { display: inline-block; margin-top: 0.4rem; }
@media (max-width: 1024px), (pointer: coarse) {
  .infotip-trigger, .infotip-close { min-width: 44px; min-height: 44px; width: 44px; height: 44px; }
}
@media (max-width: 720px) {
  .infotip-panel {
    position: fixed; left: 0.5rem; right: 0.5rem; bottom: 0.5rem; top: auto;
    width: auto; max-width: none; max-height: 60vh; overflow-y: auto;
  }
}
`;

const STYLE_ID = "s9-infotip-styles";
function ensureStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = INFOTIP_CSS;
  document.head.appendChild(el);
}

export interface InfoTipProps {
  /**
   * Sobre qué es la ayuda, en lenguaje humano («Torreta principal», «V-D-E»).
   * Da el nombre accesible del botón («Ayuda: Torreta principal») y el título
   * del panel.
   */
  topic: string;
  /** Explicación corta (texto o JSX). */
  children: ReactNode;
  /** Ruta del Centro de Ayuda con la explicación completa (p. ej. `#/help/modos/zone_control`). */
  helpHref?: string;
  /** Texto del enlace a la ayuda completa. */
  helpLabel?: string;
  /** Prefijo de data-testid (def. `infotip`): `<p>`, `<p>-trigger`, `<p>-panel`, `<p>-close`. */
  testId?: string;
  /** Abierto al montar (útil en tests y en la propia página de ayuda). */
  defaultOpen?: boolean;
}

export function InfoTip(props: InfoTipProps) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const uid = useId();
  const panelId = `infotip-${uid}`;
  const titleId = `${panelId}-t`;
  const tid = props.testId ?? "infotip";

  useEffect(ensureStyles, []);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Al abrir, el foco pasa al panel: el lector de pantalla anuncia su título.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // Pulsar/tocar fuera cierra (sin devolver el foco: el usuario ya está en otra parte).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent | MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    // Escape con el foco FUERA del ⓘ (p. ej. en <body>) también lo cierra. Con el foco
    // dentro lo atiende onKeyDown, que detiene la propagación y este no llega a verlo.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  return (
    <span
      className="infotip"
      ref={rootRef}
      data-testid={tid}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          // No se propaga: un Escape para cerrar la ayuda no debe cerrar el
          // diálogo, el editor o el menú que contienen al ⓘ.
          e.stopPropagation();
          e.preventDefault();
          close(true);
        }
      }}
      onBlur={(e) => {
        // Tab fuera del ⓘ (botón + panel) cierra el popover: no se queda flotando.
        if (!open) return;
        const next = e.relatedTarget as Node | null;
        if (next) {
          if (rootRef.current && !rootRef.current.contains(next)) setOpen(false);
          return;
        }
        // Sin relatedTarget (EQ6-P3): Tab desde el último enfocable de la página deja el
        // foco en <body>. Se mira DESPUÉS a dónde fue el foco: si salió del ⓘ, se cierra.
        // Si la ventana sólo perdió el foco (cambio de pestaña), activeElement sigue
        // dentro del ⓘ y el panel se queda abierto.
        setTimeout(() => {
          const active = document.activeElement;
          if (rootRef.current && !(active && rootRef.current.contains(active))) setOpen(false);
        }, 0);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="infotip-trigger"
        aria-label={`Ayuda: ${props.topic}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        data-testid={`${tid}-trigger`}
        onClick={(e) => {
          // type=button no tiene acción propia; se cancela la del <label> que lo contenga.
          e.preventDefault();
          if (open) close(true);
          else setOpen(true);
        }}
      >
        <span aria-hidden="true">ⓘ</span>
      </button>
      {open && (
        <span
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="infotip-panel"
          data-testid={`${tid}-panel`}
          onClick={(e) => {
            // EQ6-P2 · dentro de un <label>, un clic en el texto del panel ACTIVA el label
            // (alterna su casilla, enfoca su campo). Se cancela esa acción por defecto
            // salvo en los controles del propio panel (X, enlace a la ayuda…).
            if (!(e.target as Element).closest?.("a, button, input, select, textarea, summary, [contenteditable]"))
              e.preventDefault();
          }}
        >
          <span className="infotip-head">
            <span className="infotip-title" id={titleId}>
              {props.topic}
            </span>
            <button
              type="button"
              className="infotip-close"
              aria-label="Cerrar ayuda"
              data-testid={`${tid}-close`}
              onClick={(e) => {
                // La X se DESMONTA en este mismo clic: Chromium deja de verla como
                // contenido interactivo del <label> y lo activaría (alternando su
                // casilla). Se cancela la acción por defecto (comprobado en navegador real).
                e.preventDefault();
                close(true);
              }}
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
          <span className="infotip-body">{props.children}</span>
          {props.helpHref && (
            <a className="infotip-more" href={props.helpHref}>
              {props.helpLabel ?? "Más en el Centro de Ayuda"}
            </a>
          )}
        </span>
      )}
    </span>
  );
}
