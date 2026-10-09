/**
 * SVG rendering of annotations drawn by the app (new or modified ones). Coordinates are PDF user
 * space; the caller wraps them in a group carrying the page viewport transform.
 */
import { memo } from "react";
import { normalizeRect, rgbToCss, type Annotation } from "../../annotations/model";
import { cloudyRectPath, inkPath, lineEndingPath, markupLines, quadsPath, squigglyPath } from "../../annotations/geometry";
import { NoteIcon } from "./NoteIcon";

/** Group whose local coordinates start at the rect's top-left corner with y pointing down. */
function TopLeft({ rect, children }: { rect: [number, number, number, number]; children: React.ReactNode }) {
  const [x1, , , y2] = normalizeRect(rect);
  return <g transform={`translate(${x1} ${y2}) scale(1 -1)`}>{children}</g>;
}

export const MarkupShape = memo(function MarkupShape({ a }: { a: Annotation }) {
  if (a.kind !== "highlight" || a.hidden) return null;
  return <path d={quadsPath(a.quadPoints)} fill={rgbToCss(a.color, "#ffd400")} opacity={a.opacity} />;
});

function fitStampFont(label: string, w: number, h: number, share: number): number {
  const byHeight = h * share;
  const byWidth = (w * 0.86) / Math.max(1, label.length * 0.6);
  return Math.max(4, Math.min(byHeight, byWidth));
}

export function FreeTextBox({ a, children }: { a: Annotation; children?: React.ReactNode }) {
  const r = normalizeRect(a.rect);
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  const border = a.color && a.borderWidth > 0 ? `${a.borderWidth}px ${a.borderStyle === "dashed" ? "dashed" : "solid"} ${rgbToCss(a.color)}` : "none";
  return (
    <TopLeft rect={r}>
      <foreignObject x={0} y={0} width={Math.max(1, w)} height={Math.max(1, h)}>
        <div
          className="annot-freetext"
          style={{
            fontSize: `${a.fontSize}px`,
            color: rgbToCss(a.fontColor, "#000"),
            background: a.interiorColor ? rgbToCss(a.interiorColor) : "transparent",
            border,
            textAlign: a.textAlign,
            boxSizing: "border-box",
            opacity: a.opacity,
          }}
        >
          {children ?? a.contents}
        </div>
      </foreignObject>
    </TopLeft>
  );
}

function StampShape({ a }: { a: Annotation }) {
  const r = normalizeRect(a.rect);
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  if (a.stampImage) {
    return (
      <TopLeft rect={r}>
        <image href={a.stampImage.url} x={0} y={0} width={w} height={h} preserveAspectRatio="none" opacity={a.opacity} />
      </TopLeft>
    );
  }
  const label = a.stampLabel ?? a.subject ?? "";
  const sub = a.stampSublabel;
  const color = rgbToCss(a.color, "#c62828");
  const borderW = Math.max(1.2, Math.min(w, h) * 0.06);
  return (
    <TopLeft rect={r}>
      <foreignObject x={0} y={0} width={Math.max(1, w)} height={Math.max(1, h)}>
        <div
          className="annot-stamp-text"
          style={{
            color,
            border: `${borderW * 1.6}px double ${color}`,
            opacity: a.opacity,
            boxSizing: "border-box",
            background: "rgb(255 255 255 / 0.04)",
          }}
        >
          <span style={{ fontSize: `${fitStampFont(label, w, h, sub ? 0.42 : 0.56)}px` }}>{label}</span>
          {sub && <span style={{ fontSize: `${fitStampFont(sub, w, h, 0.2)}px`, fontWeight: 500, marginTop: 2 }}>{sub}</span>}
        </div>
      </foreignObject>
    </TopLeft>
  );
}

export const ContentShape = memo(function ContentShape({ a, hideText }: { a: Annotation; hideText?: boolean }) {
  if (a.hidden) return null;
  const stroke = rgbToCss(a.color, "none");
  const fill = a.interiorColor ? rgbToCss(a.interiorColor) : "none";
  const w = a.borderWidth;
  const dash = a.borderStyle === "dashed" ? (a.dash.length ? a.dash : [3, 3]).map((d) => d * Math.max(1, w / 2)).join(" ") : undefined;
  switch (a.kind) {
    case "underline":
    case "strikeout":
      return (
        <g opacity={a.opacity} stroke={stroke}>
          {markupLines(a.quadPoints, a.kind === "underline" ? 0 : 0.48).map((l, i) => (
            <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} strokeWidth={l.width} />
          ))}
        </g>
      );
    case "squiggly": {
      const s = squigglyPath(a.quadPoints);
      return <path d={s.d} fill="none" stroke={stroke} strokeWidth={s.width} opacity={a.opacity} strokeLinejoin="round" />;
    }
    case "ink":
      return (
        <g opacity={a.opacity} fill="none" stroke={stroke} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
          {a.inkList.map((s, i) => (
            <path key={i} d={inkPath(s)} />
          ))}
        </g>
      );
    case "square": {
      const r = normalizeRect(a.rect);
      const inset = w / 2;
      if (a.borderStyle === "cloudy") {
        return (
          <path
            d={cloudyRectPath([r[0] + inset + 3, r[1] + inset + 3, r[2] - inset - 3, r[3] - inset - 3])}
            fill={fill}
            stroke={stroke}
            strokeWidth={w}
            opacity={a.opacity}
          />
        );
      }
      return (
        <rect
          x={r[0] + inset}
          y={r[1] + inset}
          width={Math.max(0, r[2] - r[0] - w)}
          height={Math.max(0, r[3] - r[1] - w)}
          fill={fill}
          stroke={w > 0 ? stroke : "none"}
          strokeWidth={w}
          strokeDasharray={dash}
          opacity={a.opacity}
        />
      );
    }
    case "circle": {
      const r = normalizeRect(a.rect);
      return (
        <ellipse
          cx={(r[0] + r[2]) / 2}
          cy={(r[1] + r[3]) / 2}
          rx={Math.max(0, (r[2] - r[0] - w) / 2)}
          ry={Math.max(0, (r[3] - r[1] - w) / 2)}
          fill={fill}
          stroke={w > 0 ? stroke : "none"}
          strokeWidth={w}
          strokeDasharray={dash}
          opacity={a.opacity}
        />
      );
    }
    case "line": {
      if (!a.line) return null;
      const [x1, y1, x2, y2] = a.line;
      const start = lineEndingPath(a.lineEndings[0], [x1, y1], [x2, y2], w);
      const end = lineEndingPath(a.lineEndings[1], [x2, y2], [x1, y1], w);
      const endFill = a.interiorColor ? rgbToCss(a.interiorColor) : stroke;
      return (
        <g opacity={a.opacity} stroke={stroke} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
          <line x1={x1} y1={y1} x2={x2} y2={y2} strokeDasharray={dash} />
          {start && <path d={start.d} fill={start.closed ? endFill : "none"} />}
          {end && <path d={end.d} fill={end.closed ? endFill : "none"} />}
        </g>
      );
    }
    case "polygon":
    case "polyline": {
      const pts = a.vertices;
      if (pts.length < 4) return null;
      const points = pts.reduce((s, v, i) => s + (i % 2 === 0 ? `${v},` : `${v} `), "");
      if (a.kind === "polygon") {
        return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={w} strokeDasharray={dash} strokeLinejoin="round" opacity={a.opacity} />;
      }
      const n = pts.length;
      const start = lineEndingPath(a.lineEndings[0], [pts[0], pts[1]], [pts[2], pts[3]], w);
      const end = lineEndingPath(a.lineEndings[1], [pts[n - 2], pts[n - 1]], [pts[n - 4], pts[n - 3]], w);
      return (
        <g opacity={a.opacity} stroke={stroke} strokeWidth={w} strokeLinejoin="round" strokeLinecap="round">
          <polyline points={points} fill="none" strokeDasharray={dash} />
          {start && <path d={start.d} fill={start.closed ? stroke : "none"} />}
          {end && <path d={end.d} fill={end.closed ? stroke : "none"} />}
        </g>
      );
    }
    case "note": {
      const r = normalizeRect(a.rect);
      const size = Math.min(r[2] - r[0], r[3] - r[1]) || 20;
      return (
        <g transform={`translate(${r[0]} ${r[3]}) scale(${size / 20} ${-size / 20})`} opacity={a.opacity}>
          <NoteIcon name={a.icon} fill={rgbToCss(a.color, "#ffd400")} />
        </g>
      );
    }
    case "freetext":
      return hideText ? null : <FreeTextBox a={a} />;
    case "stamp":
      return <StampShape a={a} />;
    default:
      return null;
  }
});
