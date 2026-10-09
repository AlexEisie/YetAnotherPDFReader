/**
 * Dropdown / context menu with submenus and full keyboard navigation. Entries can reference
 * commands from the registry (label, icon, shortcut, enabled and checked state are taken from
 * the command).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight, type LucideIcon } from "lucide-react";
import { getCommand, isChecked, isEnabled, runCommand } from "../../commands/registry";
import { effectiveKeys } from "../../commands/keybindings";
import { formatAccelerator } from "../../commands/keys";
import { useT } from "../../i18n";

export type MenuEntry =
  | { type: "command"; id: string; label?: string }
  | {
      type: "item";
      label: string;
      icon?: LucideIcon;
      keys?: string;
      onSelect: () => void;
      disabled?: boolean;
      checked?: boolean;
      danger?: boolean;
    }
  | { type: "submenu"; label: string; icon?: LucideIcon; items: MenuEntry[] | (() => MenuEntry[]); disabled?: boolean }
  | { type: "separator" }
  | { type: "header"; label: string }
  | { type: "custom"; render: (close: () => void) => ReactNode };

export type MenuAnchor = { x: number; y: number } | DOMRect;

interface ResolvedItem {
  kind: "item" | "submenu" | "separator" | "header" | "custom";
  label: string;
  icon?: LucideIcon;
  keys?: string;
  disabled: boolean;
  checked?: boolean;
  danger?: boolean;
  run?: () => void;
  items?: MenuEntry[] | (() => MenuEntry[]);
  render?: (close: () => void) => ReactNode;
}

function useResolved(entries: MenuEntry[]): ResolvedItem[] {
  const t = useT();
  return useMemo(() => {
    const out: ResolvedItem[] = [];
    for (const e of entries) {
      switch (e.type) {
        case "command": {
          const cmd = getCommand(e.id);
          if (!cmd) break;
          const keys = effectiveKeys(cmd.id);
          out.push({
            kind: "item",
            label: e.label ?? t(cmd.label),
            icon: cmd.icon,
            keys: keys[0] ? formatAccelerator(keys[0]) : undefined,
            disabled: !isEnabled(cmd),
            checked: isChecked(cmd),
            run: () => runCommand(cmd.id),
          });
          break;
        }
        case "item":
          out.push({ kind: "item", label: e.label, icon: e.icon, keys: e.keys, disabled: !!e.disabled, checked: e.checked, danger: e.danger, run: e.onSelect });
          break;
        case "submenu":
          out.push({ kind: "submenu", label: e.label, icon: e.icon, disabled: !!e.disabled, items: e.items });
          break;
        case "separator":
          out.push({ kind: "separator", label: "", disabled: true });
          break;
        case "header":
          out.push({ kind: "header", label: e.label, disabled: true });
          break;
        case "custom":
          out.push({ kind: "custom", label: "", disabled: true, render: e.render });
          break;
      }
    }
    // Collapse duplicate / leading / trailing separators.
    return out.filter((item, i, arr) => {
      if (item.kind !== "separator") return true;
      if (i === 0 || i === arr.length - 1) return false;
      return arr[i - 1].kind !== "separator";
    });
  }, [entries, t]);
}

interface MenuProps {
  entries: MenuEntry[];
  anchor: MenuAnchor;
  onClose: () => void;
  /** Place the menu to the right of the anchor rect (submenus). */
  side?: "below" | "right";
  autoFocus?: boolean;
  level?: number;
  onKeyLeft?: () => void;
}

export function Menu({ entries, anchor, onClose, side = "below", autoFocus = true, level = 0, onKeyLeft }: MenuProps) {
  const items = useResolved(entries);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [focus, setFocus] = useState(-1);
  const [openSub, setOpenSub] = useState<{ index: number; rect: DOMRect; viaKeyboard: boolean } | null>(null);
  const subTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if ("width" in anchor) {
      if (side === "right") {
        left = anchor.right - 2;
        top = anchor.top - 5;
        if (left + w > vw - 4) left = anchor.left - w + 2;
      } else {
        left = anchor.left;
        top = anchor.bottom + 2;
        if (top + h > vh - 4) top = Math.max(4, anchor.top - h - 2);
      }
    } else {
      left = anchor.x;
      top = anchor.y;
      if (top + h > vh - 4) top = Math.max(4, vh - h - 4);
    }
    left = Math.max(4, Math.min(left, vw - w - 4));
    top = Math.max(4, Math.min(top, vh - h - 4));
    setPos({ left, top });
  }, [anchor, side, items]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (level > 0) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".menu")) onClose();
    };
    const onBlur = () => onClose();
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onBlur);
    };
  }, [level, onClose]);

  const selectable = (i: number) => items[i] && (items[i].kind === "item" || items[i].kind === "submenu") && !items[i].disabled;

  const move = (dir: 1 | -1) => {
    if (!items.length) return;
    let i = focus;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (selectable(i)) {
        setFocus(i);
        return;
      }
    }
  };

  const activate = (i: number, viaKeyboard: boolean) => {
    const item = items[i];
    if (!item || item.disabled) return;
    if (item.kind === "submenu") {
      const el = ref.current?.querySelectorAll<HTMLElement>("[data-index]")[i];
      if (el) setOpenSub({ index: i, rect: el.getBoundingClientRect(), viaKeyboard });
      return;
    }
    if (item.kind === "item") {
      onClose();
      // Run after the menu closed so focus returns to the document first.
      requestAnimationFrame(() => item.run?.());
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        move(1);
        break;
      case "ArrowUp":
        move(-1);
        break;
      case "Home":
        setFocus(-1);
        move(1);
        break;
      case "Enter":
      case " ":
        if (focus >= 0) activate(focus, true);
        break;
      case "ArrowRight":
        if (focus >= 0 && items[focus]?.kind === "submenu") activate(focus, true);
        break;
      case "ArrowLeft":
        if (level > 0) onKeyLeft?.();
        break;
      case "Escape":
        if (level > 0) onKeyLeft?.();
        else onClose();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const openSubOnHover = (i: number, el: HTMLElement) => {
    if (subTimer.current) clearTimeout(subTimer.current);
    const item = items[i];
    subTimer.current = setTimeout(() => {
      if (item.kind === "submenu" && !item.disabled) setOpenSub({ index: i, rect: el.getBoundingClientRect(), viaKeyboard: false });
      else setOpenSub(null);
    }, 120);
  };

  const sub = openSub ? items[openSub.index] : null;
  const subEntries = sub?.items ? (typeof sub.items === "function" ? sub.items() : sub.items) : null;

  return createPortal(
    <>
      <div
        ref={ref}
        className="menu"
        role="menu"
        tabIndex={-1}
        data-keys="local"
        style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((item, i) => {
          if (item.kind === "separator") return <div key={i} className="menu-sep" role="separator" />;
          if (item.kind === "header") return <div key={i} className="menu-header">{item.label}</div>;
          if (item.kind === "custom") return <div key={i}>{item.render?.(onClose)}</div>;
          const Icon = item.icon;
          return (
            <button
              key={i}
              type="button"
              data-index={i}
              role={item.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
              aria-checked={item.checked}
              aria-haspopup={item.kind === "submenu" || undefined}
              className={`menu-item${focus === i ? " focused" : ""}${item.danger ? " danger" : ""}`}
              disabled={item.disabled}
              onMouseEnter={(e) => {
                setFocus(i);
                openSubOnHover(i, e.currentTarget);
              }}
              onClick={() => activate(i, false)}
            >
              <span className="menu-icon">
                {item.checked ? <Check size={15} /> : Icon ? <Icon size={15} /> : null}
              </span>
              <span className="menu-label">{item.label}</span>
              {item.keys && <span className="menu-key">{item.keys}</span>}
              {item.kind === "submenu" && <ChevronRight size={14} className="faint" />}
            </button>
          );
        })}
        {items.length === 0 && <div className="menu-header">—</div>}
      </div>
      {openSub && subEntries && (
        <Menu
          entries={subEntries}
          anchor={openSub.rect}
          side="right"
          level={level + 1}
          autoFocus={openSub.viaKeyboard}
          onClose={onClose}
          onKeyLeft={() => {
            setOpenSub(null);
            ref.current?.focus();
          }}
        />
      )}
    </>,
    document.body,
  );
}

/** Button that opens a dropdown menu. */
export function MenuButton({
  entries,
  children,
  className = "icon-btn",
  tip,
  disabled,
}: {
  entries: MenuEntry[] | (() => MenuEntry[]);
  children: ReactNode;
  className?: string;
  tip?: string;
  disabled?: boolean;
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  return (
    <>
      <button
        type="button"
        className={className}
        data-tip={tip}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        disabled={disabled}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())}
      >
        {children}
      </button>
      {anchor && (
        <Menu entries={typeof entries === "function" ? entries() : entries} anchor={anchor} onClose={() => setAnchor(null)} />
      )}
    </>
  );
}
