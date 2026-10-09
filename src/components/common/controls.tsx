/** Small form controls shared by the settings page, dialogs and property bars. */
import { useId, useState, type ReactNode } from "react";
import { COLOR_PRESETS } from "../../settings/defaults";
import { useT } from "../../i18n";

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    />
  );
}

export interface Option<T extends string | number> {
  value: T;
  label: ReactNode;
  tip?: string;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          aria-pressed={o.value === value}
          data-tip={o.tip}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({
  value,
  options,
  onChange,
  className = "",
  disabled,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <select
      className={`select-native ${className}`}
      value={String(value)}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value;
        const match = options.find((o) => String(o.value) === raw);
        if (match) onChange(match.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format = (v) => String(v),
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  onCommit?: (v: number) => void;
}) {
  return (
    <div className="slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
        onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
      />
      <output>{format(value)}</output>
    </div>
  );
}

/** Swatch palette with optional "none" and a custom colour well. */
export function ColorPicker({
  value,
  onChange,
  allowNone = false,
  presets = COLOR_PRESETS,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  allowNone?: boolean;
  presets?: string[];
}) {
  const t = useT();
  const id = useId();
  const isCustom = value !== null && !presets.includes(value.toLowerCase());
  return (
    <div className="swatches" role="radiogroup">
      {allowNone && (
        <button
          type="button"
          className="swatch none"
          aria-pressed={value === null}
          data-tip={t("props.noFill")}
          onClick={() => onChange(null)}
        />
      )}
      {presets.map((c) => (
        <button
          key={c}
          type="button"
          className="swatch"
          style={{ background: c }}
          aria-pressed={value?.toLowerCase() === c}
          aria-label={c}
          onClick={() => onChange(c)}
        />
      ))}
      <label className="swatch custom" aria-pressed={isCustom} data-tip={t("common.custom")} htmlFor={id}>
        <input id={id} type="color" value={value ?? "#000000"} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}

/** Text input that only commits on blur / Enter. */
export function CommitInput({
  value,
  onCommit,
  placeholder,
  className = "input",
  ariaLabel,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      className={className}
      value={draft ?? value}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft !== value) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
