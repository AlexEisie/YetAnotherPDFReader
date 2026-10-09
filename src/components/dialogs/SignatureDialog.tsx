/** Create a signature (draw / type / image) and the custom text stamp editor. */
import { useEffect, useRef, useState } from "react";
import { PenLine, Stamp as StampIcon, Upload } from "lucide-react";
import { Dialog } from "../common/Dialog";
import { ColorPicker, Segmented } from "../common/controls";
import { useT } from "../../i18n";
import { imageFromCanvas } from "../../annotations/images";
import { useSignatures } from "../../state/signatures";
import { activeController } from "../../state/tabs";
import { pickImage } from "../../document/fileActions";
import { settings } from "../../settings/store";
import type { StampImage } from "../../annotations/model";
import { capturePointer } from "../../lib/dom";

const INK_COLORS = ["#111111", "#1a3fa8", "#b3261e"];
const SIGNATURE_FONTS = [
  '"Segoe Script", "Ink Free", cursive',
  '"Brush Script MT", "Segoe Script", cursive',
  '"Lucida Handwriting", "Segoe Script", cursive',
  '"STXingkai", "KaiTi", "STKaiti", "Kaiti SC", cursive',
  '"Georgia", serif',
];

/** Crop transparent borders (with a small margin). */
function trimCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = src.getContext("2d", { willReadFrequently: true });
  if (!ctx) return src;
  const { width, height } = src;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return src;
  const m = 6;
  x1 = Math.max(0, x1 - m);
  y1 = Math.max(0, y1 - m);
  x2 = Math.min(width - 1, x2 + m);
  y2 = Math.min(height - 1, y2 + m);
  const out = document.createElement("canvas");
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext("2d")!.drawImage(src, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

function DrawPad({ color, onChange }: { color: string; onChange: (canvas: HTMLCanvasElement | null) => void }) {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  const strokes = useRef(0);

  useEffect(() => {
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
  }, []);

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = ref.current!;
    capturePointer(canvas, e.pointerId);
    const ctx = canvas.getContext("2d")!;
    const r = canvas.getBoundingClientRect();
    const k = canvas.width / r.width;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    let last: [number, number] = [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
    let mid = last;
    let lastTime = performance.now();
    ctx.beginPath();
    ctx.arc(last[0], last[1], 1.4 * k, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    const move = (ev: PointerEvent) => {
      const p: [number, number] = [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k];
      const now = performance.now();
      const speed = Math.hypot(p[0] - last[0], p[1] - last[1]) / Math.max(1, now - lastTime);
      ctx.lineWidth = Math.max(1.2, Math.min(3.6, 3.4 - speed * 1.2)) * k * (ev.pressure > 0 && ev.pointerType === "pen" ? ev.pressure * 1.6 : 1);
      const nextMid: [number, number] = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
      ctx.beginPath();
      ctx.moveTo(mid[0], mid[1]);
      ctx.quadraticCurveTo(last[0], last[1], nextMid[0], nextMid[1]);
      ctx.stroke();
      mid = nextMid;
      last = p;
      lastTime = now;
    };
    const up = () => {
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      strokes.current++;
      onChange(canvas);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
  };

  return (
    <div className="col">
      <canvas ref={ref} className="signature-pad" onPointerDown={down} aria-label={t("sign.drawHint")} />
      <div className="row">
        <span className="faint" style={{ fontSize: "var(--fs-sm)" }}>{t("sign.drawHint")}</span>
        <span className="spacer" />
        <button
          type="button"
          className="btn small"
          onClick={() => {
            const canvas = ref.current!;
            canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
            strokes.current = 0;
            onChange(null);
          }}
        >
          {t("sign.clear")}
        </button>
      </div>
    </div>
  );
}

function renderTyped(text: string, font: string, color: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const size = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${size}px ${font}`;
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  canvas.width = Math.max(10, w);
  canvas.height = size * 1.6;
  const c2 = canvas.getContext("2d")!;
  c2.font = `${size}px ${font}`;
  c2.fillStyle = color;
  c2.textBaseline = "middle";
  c2.fillText(text, 20, canvas.height / 2);
  return trimCanvas(canvas);
}

export function SignatureDialog({ initials, done }: { initials?: boolean; done: () => void }) {
  const t = useT();
  const addSignature = useSignatures((s) => s.addSignature);
  const [mode, setMode] = useState<"draw" | "type" | "image">("draw");
  const [color, setColor] = useState(INK_COLORS[0]);
  const [drawn, setDrawn] = useState<HTMLCanvasElement | null>(null);
  const [text, setText] = useState(() => {
    const author = activeController()?.author() ?? settings().annotations.author;
    return initials ? author.split(/\s+/).map((w) => w[0] ?? "").join("").toUpperCase() : author;
  });
  const [font, setFont] = useState(SIGNATURE_FONTS[0]);
  const [image, setImage] = useState<StampImage | null>(null);
  const [keep, setKeep] = useState(true);

  const ready = mode === "draw" ? !!drawn : mode === "type" ? !!text.trim() : !!image;

  const confirm = async () => {
    let result: StampImage | null = null;
    if (mode === "draw" && drawn) result = await imageFromCanvas(trimCanvas(drawn));
    else if (mode === "type" && text.trim()) result = await imageFromCanvas(renderTyped(text.trim(), font, color));
    else if (mode === "image") result = image;
    if (!result) return;
    if (keep) addSignature({ kind: initials ? "initials" : "signature", url: result.url, width: result.width, height: result.height });
    activeController()?.setTool("signature", { type: "image", image: result, isSignature: true });
    done();
  };

  return (
    <Dialog
      title={initials ? t("sign.addInitials") : t("sign.title")}
      icon={PenLine}
      size="wide"
      onClose={done}
      footer={
        <>
          <label className="checkbox left">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            {t("sign.saveForLater")}
          </label>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!ready} onClick={() => void confirm()}>
            {t("common.done")}
          </button>
        </>
      }
    >
      <div className="row">
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: "draw", label: t("sign.draw") },
            { value: "type", label: t("sign.type") },
            { value: "image", label: t("sign.image") },
          ]}
        />
        <span className="spacer" />
        {mode !== "image" && <ColorPicker value={color} onChange={(v) => v && setColor(v)} presets={INK_COLORS} />}
      </div>
      {mode === "draw" && <DrawPad color={color} onChange={setDrawn} />}
      {mode === "type" && (
        <div className="col">
          <input className="input" data-autofocus value={text} placeholder={t("sign.typeHint")} onChange={(e) => setText(e.target.value)} />
          <div className="signature-grid">
            {SIGNATURE_FONTS.map((f) => (
              <button
                key={f}
                type="button"
                className="signature-option"
                style={{ fontFamily: f, fontSize: 28, color, borderColor: f === font ? "var(--accent)" : undefined, boxShadow: f === font ? "0 0 0 2px var(--accent-soft)" : undefined }}
                onClick={() => setFont(f)}
              >
                {text || "Signature"}
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === "image" && (
        <div className="col">
          <p className="faint">{t("sign.imageHint")}</p>
          <div className="signature-preview">{image ? <img src={image.url} alt="" style={{ maxHeight: "100%", maxWidth: "100%" }} /> : null}</div>
          <button type="button" className="btn" style={{ alignSelf: "flex-start" }} onClick={() => void pickImage().then((img) => img && setImage(img))}>
            <Upload size={15} /> {t("common.browse")}
          </button>
        </div>
      )}
    </Dialog>
  );
}

export function StampEditorDialog({ done }: { done: () => void }) {
  const t = useT();
  const addStamp = useSignatures((s) => s.addStamp);
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(settings().tools.stamp.color);
  const submit = () => {
    if (!label.trim()) return;
    const stamp = addStamp({ label: label.trim(), color });
    activeController()?.setTool("stamp", { type: "textStamp", label: stamp.label, sublabel: null, color: stamp.color, name: "Custom" });
    done();
  };
  return (
    <Dialog
      title={t("stamps.createCustom")}
      icon={StampIcon}
      onClose={done}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={done}>
            {t("common.cancel")}
          </button>
          <button type="button" className="btn primary" disabled={!label.trim()} onClick={submit}>
            {t("common.add")}
          </button>
        </>
      }
    >
      <div className="field">
        <label>{t("stamps.label")}</label>
        <input className="input" data-autofocus maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="field">
        <label>{t("stamps.color")}</label>
        <ColorPicker value={color} onChange={(v) => v && setColor(v)} presets={["#c62828", "#2e7d32", "#1565c0", "#ef6c00", "#6a1b9a", "#37474f"]} />
      </div>
      <div className="stamp-option" style={{ color, alignSelf: "center", minWidth: 180 }}>
        {label || "…"}
      </div>
    </Dialog>
  );
}
