/**
 * Floating UI above the pages (outside the page colour filters): hover cards, note pop-ups with
 * reply threads, the text-selection toolbar and the document context menus.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import {
  Copy,
  Highlighter,
  Lock,
  MessageSquarePlus,
  Search,
  Strikethrough,
  Trash,
  Underline,
  Unlock,
  Volume2,
  WavesHorizontal,
  X,
  StickyNote,
} from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { useAnnotState, useDocState } from "../../hooks/useDoc";
import { useT, useLocale } from "../../i18n";
import { formatDateTime } from "../../i18n/format";
import { repliesOf } from "../../annotations/store";
import { kindLabelKey, nowIso, rgbToCss, type Annotation } from "../../annotations/model";
import { Menu, type MenuEntry } from "../common/Menu";
import { settings } from "../../settings/store";
import { speakText } from "../../document/readAloud";
import { toast, useUi } from "../../state/ui";
import { copyAnnotations } from "../../state/clipboard";
import { noteAt } from "./PageOverlay";
import { runCommand } from "../../commands/registry";

/** Rectangle of an annotation in coordinates relative to `root`. */
function annotationBox(c: DocumentController, a: Annotation, root: HTMLElement): DOMRect | null {
  const view = c.layers?.pageView(a.page + 1);
  if (!view?.div?.isConnected) return null;
  const [x1, y1] = view.viewport.convertToViewportPoint(a.rect[0], a.rect[1]);
  const [x2, y2] = view.viewport.convertToViewportPoint(a.rect[2], a.rect[3]);
  const page = view.div.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  const left = page.left - rootRect.left + Math.min(x1, x2);
  const top = page.top - rootRect.top + Math.min(y1, y2);
  return new DOMRect(left, top, Math.abs(x2 - x1), Math.abs(y2 - y1));
}

/** Re-render on scroll / zoom while something floating is shown. */
function useScrollTick(c: DocumentController, active: boolean) {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const layout = useDocState(c, (s) => s.layoutVersion, 0);
  useEffect(() => {
    const el = c.scrollContainer;
    if (!active || !el) return;
    let raf = 0;
    const on = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    el.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, [c, active, layout]);
}

function HoverCard({ c, root }: { c: DocumentController; root: HTMLElement }) {
  const locale = useLocale();
  const t = useT();
  const hover = useAnnotState(c, (s) => (s.hover ? s.items[s.hover] : null), null);
  const editing = useAnnotState(c, (s) => s.editing, null);
  const enabled = settings().annotations.hoverPopups;
  useScrollTick(c, !!hover);
  if (!hover || !enabled || editing === hover.id) return null;
  const replies = repliesOf(c.annotations.getState(), hover.id).filter((r) => r.contents);
  if (!hover.contents && !replies.length && hover.kind !== "note") return null;
  const box = annotationBox(c, hover, root);
  if (!box) return null;
  const left = Math.min(root.clientWidth - 330, box.right + 8);
  const top = Math.max(6, Math.min(root.clientHeight - 120, box.top));
  return (
    <div className="hover-card" style={{ left, top }}>
      <div className="who">{hover.author || t(kindLabelKey(hover))}</div>
      <div className="text">{hover.contents || <span className="faint">{t("annots.noText")}</span>}</div>
      {replies.length > 0 && <div className="when">{t("annots.replies", { count: replies.length })}</div>}
      {hover.modified && <div className="when">{formatDateTime(hover.modified, locale)}</div>}
    </div>
  );
}

function NotePopup({ c, root }: { c: DocumentController; root: HTMLElement }) {
  const t = useT();
  const locale = useLocale();
  const a = useAnnotState(c, (s) => (s.editing ? s.items[s.editing] : null), null);
  const version = useAnnotState(c, (s) => s.version, 0);
  const [offset, setOffset] = useState<[number, number]>([0, 0]);
  const [reply, setReply] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  useScrollTick(c, !!a);

  useEffect(() => {
    setOffset([0, 0]);
    setReply("");
    if (a) requestAnimationFrame(() => textRef.current?.focus({ preventScroll: true }));
    // Focus only when a different annotation starts being edited.
  }, [a?.id]);

  if (!a || a.kind === "freetext") return null;
  const box = annotationBox(c, a, root);
  if (!box) return null;
  const replies = repliesOf(c.annotations.getState(), a.id);
  void version;
  const width = 290;
  let left = box.right + 12 + offset[0];
  if (left + width > root.clientWidth - 8) left = Math.max(8, box.left - width - 12 + offset[0]);
  const top = Math.max(8, Math.min(root.clientHeight - 260, box.top + offset[1]));
  const readOnly = a.locked || !c.canAnnotate;

  const startDrag = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const sx = e.clientX - offset[0];
    const sy = e.clientY - offset[1];
    const move = (ev: PointerEvent) => setOffset([ev.clientX - sx, ev.clientY - sy]);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const state = c.reviewState(a.id);

  return (
    <div
      className="note-popup"
      style={{ left, top, ["--note-color" as string]: rgbToCss(a.color, "#ffd400") }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") c.setEditing(null);
      }}
    >
      <div className="note-head" onPointerDown={startDrag}>
        <span className="who">{a.author || t(kindLabelKey(a))}</span>
        {state && <span className="badge">{t(`annots.status.${state.toLowerCase()}` as never)}</span>}
        <button type="button" className="icon-btn small" aria-label={t("props.delete")} disabled={readOnly} onClick={() => c.deleteAnnotations([a.id])}>
          <Trash size={14} />
        </button>
        <button type="button" className="icon-btn small" aria-label={t("common.close")} onClick={() => c.setEditing(null)}>
          <X size={14} />
        </button>
      </div>
      <div className="note-body">
        <textarea
          ref={textRef}
          value={a.contents}
          readOnly={readOnly}
          placeholder={t("note.placeholder")}
          onChange={(e) => c.updateAnnotation(a.id, { contents: e.target.value }, { mergeKey: `contents:${a.id}`, label: t("history.edit", { kind: t(kindLabelKey(a)) }) })}
        />
        {a.modified && <div className="faint" style={{ fontSize: "var(--fs-xs)" }}>{formatDateTime(a.modified, locale)}</div>}
        {replies.map((r) => (
          <div key={r.id} className="reply">
            <div className="row">
              <span className="who">{r.author || "—"}</span>
              <span className="spacer" />
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>{formatDateTime(r.created ?? r.modified, locale)}</span>
              {!readOnly && (
                <button type="button" className="icon-btn small" aria-label={t("common.delete")} onClick={() => c.deleteAnnotations([r.id])}>
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="text">{r.contents}</div>
          </div>
        ))}
      </div>
      {!readOnly && (
        <form
          className="note-foot"
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) {
              c.addReply(a.id, reply);
              setReply("");
            }
          }}
        >
          <input className="input" value={reply} placeholder={t("annots.addReply")} onChange={(e) => setReply(e.target.value)} />
          <button type="submit" className="btn small primary" disabled={!reply.trim()}>
            {t("annots.reply")}
          </button>
        </form>
      )}
    </div>
  );
}

function SelectionToolbar({ c, root }: { c: DocumentController; root: HTMLElement }) {
  const t = useT();
  const sel = useDocState(c, (s) => s.selection, null);
  const tool = useDocState(c, (s) => s.tool, "select");
  const canAnnotate = c.canAnnotate;
  if (!sel || tool !== "select") return null;
  const rootRect = root.getBoundingClientRect();
  const left = Math.max(6, Math.min(root.clientWidth - 300, sel.x - rootRect.left - 120));
  let top = sel.top - rootRect.top - 44;
  if (top < 4) top = sel.y - rootRect.top + 8;
  const markup = (tl: "highlight" | "underline" | "strikeout" | "squiggly") => c.markupFromSelection(tl);
  const colors = settings().tools;
  return (
    <div className="selection-toolbar" style={{ left, top }} onPointerDown={(e) => e.preventDefault()}>
      <button
        type="button"
        className="icon-btn"
        data-tip={t("common.copy")}
        onClick={() => {
          void navigator.clipboard.writeText(sel.text);
          toast("success", t("toast.copied"));
        }}
      >
        <Copy size={16} />
      </button>
      {canAnnotate && (
        <>
          <button type="button" className="icon-btn" data-tip={t("cmd.tool.highlight")} onClick={() => markup("highlight")}>
            <Highlighter size={16} color={colors.highlight.color} />
          </button>
          <button type="button" className="icon-btn" data-tip={t("cmd.tool.underline")} onClick={() => markup("underline")}>
            <Underline size={16} color={colors.underline.color} />
          </button>
          <button type="button" className="icon-btn" data-tip={t("cmd.tool.strikeout")} onClick={() => markup("strikeout")}>
            <Strikethrough size={16} color={colors.strikeout.color} />
          </button>
          <button type="button" className="icon-btn" data-tip={t("cmd.tool.squiggly")} onClick={() => markup("squiggly")}>
            <WavesHorizontal size={16} color={colors.squiggly.color} />
          </button>
          <button
            type="button"
            className="icon-btn"
            data-tip={t("annots.edit")}
            onClick={() => {
              if (c.markupFromSelection("highlight")) {
                const id = c.annotations.getState().selection[0];
                if (id) c.setEditing(id);
              }
            }}
          >
            <MessageSquarePlus size={16} />
          </button>
        </>
      )}
      <button type="button" className="icon-btn" data-tip={t("cmd.tts.readPage")} onClick={() => void speakText(sel.text)}>
        <Volume2 size={16} />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-tip={t("common.search")}
        onClick={() => {
          c.find(sel.text.trim().slice(0, 200));
          useUi.setState((s) => ({ findOpen: true, findFocus: s.findFocus + 1 }));
        }}
      >
        <Search size={16} />
      </button>
    </div>
  );
}

function DocContextMenu({ c }: { c: DocumentController }) {
  const t = useT();
  const req = useDocState(c, (s) => s.contextMenu, null);
  if (!req) return null;
  const close = () => c.closeContextMenu();
  let entries: MenuEntry[] = [];

  if (req.kind === "text") {
    const text = document.getSelection()?.toString() ?? "";
    const canAnnotate = c.canAnnotate;
    entries = [
      { type: "item", label: t("common.copy"), icon: Copy, keys: "Ctrl+C", onSelect: () => void navigator.clipboard.writeText(text) },
      { type: "separator" },
      { type: "item", label: t("cmd.tool.highlight"), icon: Highlighter, disabled: !canAnnotate, onSelect: () => c.markupFromSelection("highlight") },
      { type: "item", label: t("cmd.tool.underline"), icon: Underline, disabled: !canAnnotate, onSelect: () => c.markupFromSelection("underline") },
      { type: "item", label: t("cmd.tool.strikeout"), icon: Strikethrough, disabled: !canAnnotate, onSelect: () => c.markupFromSelection("strikeout") },
      { type: "item", label: t("cmd.tool.squiggly"), icon: WavesHorizontal, disabled: !canAnnotate, onSelect: () => c.markupFromSelection("squiggly") },
      { type: "separator" },
      {
        type: "item",
        label: `${t("common.search")}: “${text.trim().slice(0, 24)}${text.trim().length > 24 ? "…" : ""}”`,
        icon: Search,
        onSelect: () => {
          c.find(text.trim().slice(0, 200));
          useUi.setState((s) => ({ findOpen: true, findFocus: s.findFocus + 1 }));
        },
      },
      { type: "item", label: t("cmd.tts.readPage"), icon: Volume2, onSelect: () => void speakText(text) },
      { type: "separator" },
      { type: "command", id: "edit.selectAll" },
    ];
  } else if (req.kind === "annotation" && req.annotationId) {
    const a = c.getAnnotation(req.annotationId);
    if (a) {
      const canEdit = c.canAnnotate && !a.locked;
      const statuses = ["Accepted", "Rejected", "Cancelled", "Completed", "None"];
      entries = [
        { type: "item", label: t("props.openPopup"), icon: StickyNote, onSelect: () => c.setEditing(a.id) },
        { type: "item", label: t("props.copyText"), icon: Copy, disabled: !a.contents, onSelect: () => void navigator.clipboard.writeText(a.contents) },
        { type: "separator" },
        {
          type: "submenu",
          label: t("annots.status"),
          disabled: !c.canAnnotate,
          items: statuses.map<MenuEntry>((s) => ({
            type: "item",
            label: t(`annots.status.${s.toLowerCase()}` as never),
            checked: (c.reviewState(a.id) ?? "None") === s,
            onSelect: () => c.setReviewState(a.id, s),
          })),
        },
        {
          type: "item",
          label: t("props.duplicate"),
          disabled: !canEdit || a.kind === "other",
          onSelect: () => {
            copyAnnotations([a]);
            runCommand("edit.paste");
          },
        },
        {
          type: "item",
          label: t("props.locked"),
          icon: a.locked ? Unlock : Lock,
          checked: a.locked,
          disabled: !c.canAnnotate,
          // Toggled through commit() because updateAnnotation refuses to touch locked comments.
          onSelect: () => {
            const before = c.getAnnotation(a.id);
            if (before) {
              const after = { ...before, locked: !before.locked, modified: nowIso() };
              c.commit(t("history.edit", { kind: t(kindLabelKey(before)) }), [{ id: a.id, before, after }]);
            }
          },
        },
        { type: "separator" },
        { type: "item", label: t("common.delete"), icon: Trash, danger: true, disabled: !canEdit, onSelect: () => c.deleteAnnotations([a.id]) },
      ];
    }
  } else {
    const page = req.page;
    entries = [
      { type: "command", id: "tool.select" },
      { type: "command", id: "tool.hand" },
      { type: "separator" },
      {
        type: "item",
        label: t("cmd.tool.note"),
        icon: StickyNote,
        disabled: !c.canAnnotate || page === null,
        onSelect: () => {
          if (page === null) return;
          const view = c.layers?.pageView(page);
          if (!view) return;
          const r = view.div.getBoundingClientRect();
          const [x, y] = view.viewport.convertToPdfPoint(req.x - r.left, req.y - r.top);
          const a = noteAt(page - 1, x, y, c.author());
          c.addAnnotation(a, { select: true, edit: true });
        },
      },
      { type: "separator" },
      { type: "command", id: "go.back" },
      { type: "command", id: "go.forward" },
      { type: "separator" },
      {
        type: "submenu",
        label: t("menu.zoom"),
        items: [
          { type: "command", id: "view.zoomIn" },
          { type: "command", id: "view.zoomOut" },
          { type: "separator" },
          { type: "command", id: "view.actualSize" },
          { type: "command", id: "view.fitPage" },
          { type: "command", id: "view.fitWidth" },
        ],
      },
      {
        type: "submenu",
        label: t("menu.pageDisplay"),
        items: [
          { type: "command", id: "view.layout.single" },
          { type: "command", id: "view.layout.continuous" },
          { type: "command", id: "view.layout.twoPage" },
          { type: "command", id: "view.layout.twoPageContinuous" },
          { type: "command", id: "view.layout.horizontal" },
          { type: "command", id: "view.layout.wrapped" },
        ],
      },
      {
        type: "submenu",
        label: t("menu.pageBackground"),
        items: [
          { type: "command", id: "view.bg.normal" },
          { type: "command", id: "view.bg.dark" },
          { type: "command", id: "view.bg.night" },
          { type: "command", id: "view.bg.sepia" },
          { type: "command", id: "view.bg.green" },
        ],
      },
      { type: "command", id: "view.rotateCw" },
      { type: "separator" },
      {
        type: "submenu",
        label: t("menu.pages"),
        items: [
          { type: "command", id: "page.rotateCw" },
          { type: "command", id: "page.rotateCcw" },
          { type: "command", id: "page.insertBlank" },
          { type: "command", id: "page.delete" },
          { type: "command", id: "page.extract" },
        ],
      },
      { type: "command", id: "file.print" },
      { type: "command", id: "file.properties" },
    ];
  }
  return <Menu entries={entries} anchor={{ x: req.x, y: req.y }} onClose={close} />;
}

export function FloatingLayer({ c, root }: { c: DocumentController; root: HTMLElement | null }) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useLayoutEffect(() => {
    if (!root) force();
  }, [root]);
  if (!root) return null;
  return (
    <div className="floating-layer">
      <HoverCard c={c} root={root} />
      <NotePopup c={c} root={root} />
      <SelectionToolbar c={c} root={root} />
      <DocContextMenu c={c} />
    </div>
  );
}
