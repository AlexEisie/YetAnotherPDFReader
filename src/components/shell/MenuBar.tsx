/** Classic menu bar (File, Edit, View, ...). Hidden menu bars can be revealed with Alt. */
import { useEffect, useRef, useState } from "react";
import { Menu } from "../common/Menu";
import { MENUS } from "./menus";
import { useT } from "../../i18n";
import { useUi } from "../../state/ui";

export function MenuBar() {
  const t = useT();
  const [open, setOpen] = useState<{ index: number; rect: DOMRect } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const openAt = (index: number) => {
    const btn = barRef.current?.querySelectorAll<HTMLButtonElement>(".menubar-item")[index];
    if (btn) setOpen({ index, rect: btn.getBoundingClientRect() });
  };

  // Left / Right switch between top-level menus while one is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const target = e.target as HTMLElement;
        if (target.closest(".menu") && e.key === "ArrowRight" && target.querySelector?.("[aria-haspopup].focused")) return;
        e.preventDefault();
        openAt((open.index + (e.key === "ArrowRight" ? 1 : MENUS.length - 1)) % MENUS.length);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="menubar" ref={barRef} role="menubar">
      {MENUS.map((m, i) => (
        <button
          key={m.id}
          type="button"
          className="menubar-item"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open?.index === i}
          onPointerDown={(e) => {
            e.preventDefault();
            if (open?.index === i) setOpen(null);
            else openAt(i);
          }}
          onMouseEnter={() => {
            if (open && open.index !== i) openAt(i);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
              e.preventDefault();
              openAt(i);
            }
          }}
        >
          {t(m.label)}
        </button>
      ))}
      {open && (
        <Menu
          key={open.index}
          entries={MENUS[open.index].entries()}
          anchor={open.rect}
          onClose={() => {
            setOpen(null);
            useUi.setState({ menuBarPeek: false });
          }}
        />
      )}
    </div>
  );
}
