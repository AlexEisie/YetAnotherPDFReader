/** Second toolbar row with the comment tools, stamp / signature pickers and style controls. */
import { ChevronDown, PenLine, Plus, Stamp as StampIcon, Trash, X } from "lucide-react";
import { useT, currentLocale } from "../../i18n";
import { useActiveController, useDocState } from "../../hooks/useDoc";
import { getCommand, runCommand, isEnabled } from "../../commands/registry";
import { effectiveKeys } from "../../commands/keybindings";
import { formatAccelerator } from "../../commands/keys";
import { PropertiesBar } from "./PropertiesBar";
import { PopoverButton } from "../common/Popover";
import { STANDARD_STAMPS, DYNAMIC_STAMPS, SIGN_HERE_STAMPS, dynamicSublabel, type StampPreset } from "../../annotations/stamps";
import { useSignatures, signatureImage } from "../../state/signatures";
import { openDialog, useUi } from "../../state/ui";
import { settings, useSettings } from "../../settings/store";
import type { DocumentController } from "../../document/DocumentController";
import type { ToolId } from "../../annotations/tools";

const TOOL_IDS: ToolId[] = [
  "select",
  "hand",
  "note",
  "highlight",
  "underline",
  "strikeout",
  "squiggly",
  "freetext",
  "ink",
  "eraser",
  "square",
  "circle",
  "line",
  "arrow",
  "polygon",
  "polyline",
];

function ToolButton({ c, id }: { c: DocumentController; id: ToolId }) {
  const t = useT();
  const active = useDocState(c, (s) => s.tool === id, false);
  const cmd = getCommand(`tool.${id}`);
  if (!cmd) return null;
  const Icon = cmd.icon!;
  const keys = effectiveKeys(cmd.id);
  return (
    <button
      type="button"
      className="icon-btn"
      aria-pressed={active}
      disabled={!isEnabled(cmd, c)}
      data-tip={t(cmd.label)}
      data-tip-key={keys[0] ? formatAccelerator(keys[0]) : undefined}
      onClick={() => c.setTool(active && id !== "select" ? "select" : id)}
    >
      <Icon size={18} />
    </button>
  );
}

function StampPreview({ preset, label }: { preset: StampPreset; label: string }) {
  return (
    <span className="stamp-option" style={{ color: preset.color }}>
      {label}
    </span>
  );
}

function StampPicker({ c }: { c: DocumentController }) {
  const t = useT();
  const custom = useSignatures((s) => s.stamps);
  const removeStamp = useSignatures((s) => s.removeStamp);
  const active = useDocState(c, (s) => s.tool === "stamp", false);

  const choose = (preset: StampPreset, close: () => void) => {
    const label = t(preset.label);
    c.setTool("stamp", {
      type: "textStamp",
      label,
      sublabel: preset.dynamic ? dynamicSublabel(c.author(), currentLocale()) : null,
      color: preset.color,
      name: preset.name,
    });
    useSettings.getState().set("ui.recentStamps", [preset.name, ...settings().ui.recentStamps.filter((n) => n !== preset.name)].slice(0, 6));
    close();
  };

  return (
    <PopoverButton
      className={`icon-btn${active ? " active" : ""}`}
      tip={t("cmd.tool.stamp")}
      disabled={!c.canAnnotate}
      content={(close) => (
        <div style={{ width: 340, display: "flex", flexDirection: "column", gap: 10, maxHeight: 460, overflow: "auto" }}>
          <div className="menu-header">{t("stamps.standard")}</div>
          <div className="stamp-grid">
            {STANDARD_STAMPS.map((p) => (
              <button key={p.name} type="button" style={{ all: "unset" }} onClick={() => choose(p, close)}>
                <StampPreview preset={p} label={t(p.label)} />
              </button>
            ))}
          </div>
          <div className="menu-header">{t("stamps.dynamic")}</div>
          <div className="stamp-grid">
            {DYNAMIC_STAMPS.map((p) => (
              <button key={`d-${p.name}`} type="button" style={{ all: "unset" }} onClick={() => choose(p, close)}>
                <StampPreview preset={p} label={t(p.label)} />
              </button>
            ))}
          </div>
          <div className="menu-header">{t("cmd.tool.signature")}</div>
          <div className="stamp-grid">
            {SIGN_HERE_STAMPS.map((p) => (
              <button key={`s-${p.name}`} type="button" style={{ all: "unset" }} onClick={() => choose(p, close)}>
                <StampPreview preset={p} label={t(p.label)} />
              </button>
            ))}
          </div>
          <div className="menu-header">{t("stamps.custom")}</div>
          <div className="stamp-grid">
            {custom.map((s) => (
              <div key={s.id} style={{ position: "relative" }}>
                <button
                  type="button"
                  style={{ all: "unset", display: "block" }}
                  onClick={() => {
                    c.setTool("stamp", { type: "textStamp", label: s.label, sublabel: null, color: s.color, name: "Custom" });
                    close();
                  }}
                >
                  <span className="stamp-option" style={{ color: s.color }}>
                    {s.label}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-btn small"
                  style={{ position: "absolute", top: -6, right: -6, background: "var(--surface)" }}
                  aria-label={t("common.delete")}
                  onClick={() => removeStamp(s.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn"
              style={{ height: 46 }}
              onClick={() => {
                close();
                void openDialog("stampEditor", {});
              }}
            >
              <Plus size={16} /> {t("stamps.createCustom")}
            </button>
          </div>
        </div>
      )}
    >
      <StampIcon size={18} />
      <ChevronDown size={12} className="caret" />
    </PopoverButton>
  );
}

function SignatureButton({ c }: { c: DocumentController }) {
  const t = useT();
  const signatures = useSignatures((s) => s.signatures);
  const remove = useSignatures((s) => s.removeSignature);
  const active = useDocState(c, (s) => s.tool === "signature", false);

  const place = async (id: string, close: () => void) => {
    const sig = signatures.find((s) => s.id === id);
    if (!sig) return;
    close();
    const image = await signatureImage(sig);
    c.setTool("signature", { type: "image", image, isSignature: true });
  };

  return (
    <PopoverButton
      className={`icon-btn${active ? " active" : ""}`}
      tip={t("cmd.tool.signature")}
      disabled={!c.canAnnotate}
      content={(close) => (
        <div style={{ width: 300, display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="menu-header">{t("sign.manage")}</div>
          {signatures.length === 0 && <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>{t("sign.empty")}</div>}
          <div className="signature-grid">
            {signatures.map((s) => (
              <div key={s.id} className="signature-option" onClick={() => void place(s.id, close)} role="button" tabIndex={0}>
                <img src={s.url} alt="" />
                <button
                  type="button"
                  className="icon-btn small remove"
                  aria-label={t("sign.delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(s.id);
                  }}
                >
                  <Trash size={13} />
                </button>
              </div>
            ))}
          </div>
          <div className="row">
            <button
              type="button"
              className="btn small"
              onClick={() => {
                close();
                void openDialog("signature", {});
              }}
            >
              <Plus size={14} /> {t("sign.add")}
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => {
                close();
                void openDialog("signature", { initials: true });
              }}
            >
              <Plus size={14} /> {t("sign.addInitials")}
            </button>
          </div>
        </div>
      )}
    >
      <PenLine size={18} />
      <ChevronDown size={12} className="caret" />
    </PopoverButton>
  );
}

export function CommentToolbar() {
  const t = useT();
  const c = useActiveController();
  const ready = useDocState(c, (s) => s.status === "ready", false);
  if (!c || !ready) return null;
  return (
    <div className="subtoolbar" role="toolbar" aria-label={t("tools.title")}>
      {TOOL_IDS.map((id) => (
        <ToolButton key={id} c={c} id={id} />
      ))}
      <StampPicker c={c} />
      <SignatureButton c={c} />
      <button type="button" className="icon-btn" data-tip={t("cmd.tool.image")} disabled={!c.canAnnotate} onClick={() => runCommand("tool.image")}>
        {(() => {
          const Icon = getCommand("tool.image")!.icon!;
          return <Icon size={18} />;
        })()}
      </button>
      <div className="toolbar-sep" />
      <PropertiesBar c={c} />
      <div className="spacer" />
      <button type="button" className="icon-btn small" data-tip={t("tools.close")} onClick={() => useUi.setState({ commentTools: false })}>
        <X size={16} />
      </button>
    </div>
  );
}
