/**
 * Style controls for the selected annotations — or, when nothing is selected, for the defaults
 * of the active tool (stored in settings).
 */
import { AlignCenter, AlignLeft, AlignRight, Trash } from "lucide-react";
import { useT } from "../../i18n";
import type { DocumentController } from "../../document/DocumentController";
import { useAnnotState, useDocState, shallowEqual } from "../../hooks/useDoc";
import { useSettings } from "../../settings/store";
import type { Settings } from "../../settings/defaults";
import { hexToRgb, rgbToHex, type Annotation, type ModelKind } from "../../annotations/model";
import type { BorderStyle, LineEnding, TextAlign } from "../../annotations/dto";
import type { ToolId } from "../../annotations/tools";
import { ColorPicker, Select } from "../common/controls";
import { PopoverButton } from "../common/Popover";

/** Which properties a kind of annotation exposes. */
interface Caps {
  color: boolean;
  opacity: boolean;
  width: boolean;
  fill: boolean;
  font: boolean;
  border: boolean;
  endings: boolean;
  icon: boolean;
}

const NONE: Caps = { color: false, opacity: false, width: false, fill: false, font: false, border: false, endings: false, icon: false };

function capsFor(kind: ModelKind | ToolId | null): Caps {
  switch (kind) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return { ...NONE, color: true, opacity: true };
    case "note":
      return { ...NONE, color: true, icon: true };
    case "freetext":
      return { ...NONE, color: true, fill: true, font: true, width: true };
    case "ink":
      return { ...NONE, color: true, opacity: true, width: true };
    case "square":
    case "circle":
    case "polygon":
      return { ...NONE, color: true, opacity: true, width: true, fill: true, border: true };
    case "line":
    case "arrow":
    case "polyline":
      return { ...NONE, color: true, opacity: true, width: true, endings: true };
    case "stamp":
      return { ...NONE, opacity: true };
    default:
      return NONE;
  }
}

interface StyleValues {
  color: string | null;
  opacity: number;
  width: number;
  fill: string | null;
  fontSize: number;
  fontColor: string | null;
  borderStyle: BorderStyle;
  startEnding: LineEnding;
  endEnding: LineEnding;
  icon: string;
  textAlign: TextAlign;
}

function valuesFromAnnotation(a: Annotation): StyleValues {
  return {
    color: rgbToHex(a.color),
    opacity: a.opacity,
    width: a.borderWidth,
    fill: rgbToHex(a.interiorColor),
    fontSize: a.fontSize,
    fontColor: rgbToHex(a.fontColor) ?? "#000000",
    borderStyle: a.borderStyle,
    startEnding: a.lineEndings[0],
    endEnding: a.lineEndings[1],
    icon: a.icon ?? "Comment",
    textAlign: a.textAlign,
  };
}

function valuesFromTool(tool: ToolId, s: Settings): StyleValues {
  const tl = s.tools;
  const base: StyleValues = {
    color: null,
    opacity: 1,
    width: 1,
    fill: null,
    fontSize: 12,
    fontColor: "#000000",
    borderStyle: "solid",
    startEnding: "None",
    endEnding: "None",
    icon: "Comment",
    textAlign: "left",
  };
  switch (tool) {
    case "highlight":
    case "underline":
    case "strikeout":
    case "squiggly":
      return { ...base, color: tl[tool].color, opacity: tl[tool].opacity };
    case "note":
      return { ...base, color: tl.note.color, icon: tl.note.icon };
    case "freetext":
      return {
        ...base,
        color: tl.freetext.borderColor,
        width: tl.freetext.borderWidth,
        fill: tl.freetext.fill,
        fontSize: tl.freetext.fontSize,
        fontColor: tl.freetext.fontColor,
      };
    case "ink":
      return { ...base, color: tl.ink.color, width: tl.ink.width, opacity: tl.ink.opacity };
    case "square":
    case "circle":
    case "polygon":
      return { ...base, color: tl.shape.color, width: tl.shape.width, fill: tl.shape.fill, opacity: tl.shape.opacity, borderStyle: tl.shape.borderStyle };
    case "line":
    case "arrow":
    case "polyline":
      return { ...base, color: tl.line.color, width: tl.line.width, opacity: tl.line.opacity, startEnding: tl.line.startEnding, endEnding: tl.line.endEnding };
    case "stamp":
      return { ...base, color: tl.stamp.color };
    default:
      return base;
  }
}

/** Settings path for a tool property, or null when the tool has no such default. */
function toolPath(tool: ToolId, prop: keyof StyleValues): string | null {
  const group =
    tool === "square" || tool === "circle" || tool === "polygon"
      ? "shape"
      : tool === "line" || tool === "arrow" || tool === "polyline"
        ? "line"
        : tool;
  const map: Record<string, Partial<Record<keyof StyleValues, string>>> = {
    highlight: { color: "color", opacity: "opacity" },
    underline: { color: "color", opacity: "opacity" },
    strikeout: { color: "color", opacity: "opacity" },
    squiggly: { color: "color", opacity: "opacity" },
    note: { color: "color", icon: "icon" },
    freetext: { color: "borderColor", width: "borderWidth", fill: "fill", fontSize: "fontSize", fontColor: "fontColor" },
    ink: { color: "color", width: "width", opacity: "opacity" },
    shape: { color: "color", width: "width", fill: "fill", opacity: "opacity", borderStyle: "borderStyle" },
    line: { color: "color", width: "width", opacity: "opacity", startEnding: "startEnding", endEnding: "endEnding" },
    stamp: { color: "color" },
  };
  const key = map[group]?.[prop];
  return key ? `tools.${group}.${key}` : null;
}

function patchFor(prop: keyof StyleValues, value: unknown, a: Annotation): Partial<Annotation> {
  switch (prop) {
    case "color":
      return { color: hexToRgb(value as string | null) };
    case "opacity":
      return { opacity: value as number };
    case "width":
      return { borderWidth: value as number };
    case "fill":
      return { interiorColor: hexToRgb(value as string | null) };
    case "fontSize":
      return { fontSize: value as number };
    case "fontColor":
      return { fontColor: hexToRgb(value as string) };
    case "borderStyle":
      return { borderStyle: value as BorderStyle, dash: value === "dashed" ? [3, 3] : [] };
    case "startEnding":
      return { lineEndings: [value as LineEnding, a.lineEndings[1]] };
    case "endEnding":
      return { lineEndings: [a.lineEndings[0], value as LineEnding] };
    case "icon":
      return { icon: value as string };
    case "textAlign":
      return { textAlign: value as TextAlign };
  }
}

const ENDINGS: LineEnding[] = ["None", "OpenArrow", "ClosedArrow", "Circle", "Square", "Diamond", "Butt", "Slash", "ROpenArrow", "RClosedArrow"];
const ICONS = ["Comment", "Note", "Help", "Insert", "Key", "NewParagraph", "Paragraph", "Check", "Cross", "Star", "Circle"];

function ColorButton({ value, onChange, allowNone, tip }: { value: string | null; onChange: (v: string | null) => void; allowNone?: boolean; tip: string }) {
  return (
    <PopoverButton
      className="color-button"
      tip={tip}
      content={(close) => (
        <div style={{ width: 236 }}>
          <ColorPicker
            value={value}
            allowNone={allowNone}
            onChange={(v) => {
              onChange(v);
              if (v === null || !v.startsWith("#") || v.length === 7) close();
            }}
          />
        </div>
      )}
    >
      <span className={`chip${value ? "" : " none"}`} style={value ? { background: value } : undefined} />
    </PopoverButton>
  );
}

export function PropertiesBar({ c }: { c: DocumentController }) {
  const t = useT();
  const selection = useAnnotState(c, (s) => s.selection, [] as string[], shallowEqual);
  const first = useAnnotState(c, (s) => (s.selection[0] ? s.items[s.selection[0]] : null), null);
  const tool = useDocState(c, (s) => s.tool, "select");
  const settings = useSettings((s) => s.settings);
  const setSetting = useSettings((s) => s.set);

  const editingSelection = !!first;
  const kind: ModelKind | ToolId | null = first ? (first.kind === "line" && first.lineEndings[1] !== "None" ? "line" : first.kind) : tool;
  const caps = capsFor(kind);
  if (!editingSelection && !Object.values(caps).some(Boolean)) return null;
  if (first && (first.locked || !c.canAnnotate)) return null;
  const values = first ? valuesFromAnnotation(first) : valuesFromTool(tool, settings);
  const readOnlyStyle = !!first && !first.editable;

  const change = (prop: keyof StyleValues, value: unknown, merge = false) => {
    if (first) {
      if (selection.length === 1) {
        c.updateAnnotation(first.id, patchFor(prop, value, first), {
          label: t("history.style", { kind: t(`kind.${first.kind === "other" ? "stamp" : first.kind}` as never) }),
          mergeKey: merge ? `style:${prop}:${first.id}` : undefined,
        });
      } else {
        const items = c.annotations.getState().items;
        for (const id of selection) {
          const a = items[id];
          if (a) c.updateAnnotation(id, patchFor(prop, value, a), { mergeKey: `style:${prop}:${selection.join()}` });
        }
      }
    } else {
      const path = toolPath(tool, prop);
      if (path) setSetting(path, value);
    }
  };

  if (readOnlyStyle) {
    return (
      <div className="props-bar">
        <span className="prop-label">{t("props.readOnlyExisting")}</span>
        <button type="button" className="icon-btn small" data-tip={t("props.delete")} onClick={() => c.deleteAnnotations(selection)}>
          <Trash size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="props-bar">
      {caps.color && (
        <ColorButton
          tip={kind === "freetext" ? t("props.borderStyle") : t("props.color")}
          value={values.color}
          allowNone={kind === "freetext"}
          onChange={(v) => change("color", v)}
        />
      )}
      {caps.fill && <ColorButton tip={t("props.fill")} value={values.fill} allowNone onChange={(v) => change("fill", v)} />}
      {caps.font && (
        <>
          <ColorButton tip={t("props.textColor")} value={values.fontColor} onChange={(v) => change("fontColor", v ?? "#000000")} />
          <Select
            className="input small"
            ariaLabel={t("props.fontSize")}
            value={values.fontSize}
            options={[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 64, 72].map((n) => ({ value: n, label: `${n} pt` }))}
            onChange={(v) => change("fontSize", v)}
          />
          {first && (
            <div className="btn-group">
              {(["left", "center", "right"] as TextAlign[]).map((al) => {
                const Icon = al === "left" ? AlignLeft : al === "center" ? AlignCenter : AlignRight;
                return (
                  <button
                    key={al}
                    type="button"
                    className="icon-btn small"
                    aria-pressed={values.textAlign === al}
                    data-tip={t(`props.align.${al}`)}
                    onClick={() => change("textAlign", al)}
                  >
                    <Icon size={15} />
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
      {caps.width && (
        <>
          <span className="prop-label">{t("props.thickness")}</span>
          <input
            type="range"
            className="mini-slider"
            min={kind === "freetext" || kind === "square" || kind === "circle" || kind === "polygon" ? 0 : 0.5}
            max={kind === "ink" ? 24 : 12}
            step={0.5}
            value={values.width}
            onChange={(e) => change("width", Number(e.target.value), true)}
            aria-label={t("props.thickness")}
          />
          <span className="prop-label" style={{ minWidth: 34 }}>
            {values.width} pt
          </span>
        </>
      )}
      {caps.opacity && (
        <>
          <span className="prop-label">{t("props.opacity")}</span>
          <input
            type="range"
            className="mini-slider"
            min={0.05}
            max={1}
            step={0.05}
            value={values.opacity}
            onChange={(e) => change("opacity", Number(e.target.value), true)}
            aria-label={t("props.opacity")}
          />
          <span className="prop-label" style={{ minWidth: 34 }}>
            {Math.round(values.opacity * 100)}%
          </span>
        </>
      )}
      {caps.border && (
        <Select
          className="input small"
          ariaLabel={t("props.borderStyle")}
          value={values.borderStyle}
          options={[
            { value: "solid", label: t("props.border.solid") },
            { value: "dashed", label: t("props.border.dashed") },
            { value: "cloudy", label: t("props.border.cloudy") },
          ]}
          onChange={(v) => change("borderStyle", v)}
        />
      )}
      {caps.endings && (
        <>
          <Select
            className="input small"
            ariaLabel={t("props.lineStart")}
            value={values.startEnding}
            options={ENDINGS.map((e) => ({ value: e, label: `${t("props.lineStart")}: ${t(`ending.${e}`)}` }))}
            onChange={(v) => change("startEnding", v)}
          />
          <Select
            className="input small"
            ariaLabel={t("props.lineEnd")}
            value={values.endEnding}
            options={ENDINGS.map((e) => ({ value: e, label: `${t("props.lineEnd")}: ${t(`ending.${e}`)}` }))}
            onChange={(v) => change("endEnding", v)}
          />
        </>
      )}
      {caps.icon && (
        <Select
          className="input small"
          ariaLabel={t("props.icon")}
          value={values.icon}
          options={ICONS.map((i) => ({ value: i, label: t(`icon.${i}` as never) }))}
          onChange={(v) => change("icon", v)}
        />
      )}
      {first && (
        <>
          <button
            type="button"
            className="btn ghost small"
            data-tip={t("props.setDefault")}
            onClick={() => {
              const k = first.kind === "line" && first.lineEndings[1] !== "None" ? "arrow" : (first.kind as ToolId);
              for (const prop of Object.keys(values) as (keyof StyleValues)[]) {
                const path = toolPath(k, prop);
                if (path) setSetting(path, values[prop]);
              }
            }}
          >
            {t("props.setDefault")}
          </button>
          <button type="button" className="icon-btn small" data-tip={t("props.delete")} onClick={() => c.deleteAnnotations(selection)}>
            <Trash size={15} />
          </button>
        </>
      )}
    </div>
  );
}
