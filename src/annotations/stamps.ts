/** Built-in rubber stamps (Acrobat's "Standard Business" and "Sign Here" sets). */
import type { MessageKey } from "../i18n";

export interface StampPreset {
  name: string;
  label: MessageKey;
  color: string;
  /** Adds "<author>, <date>" as a second line. */
  dynamic?: boolean;
}

export const STANDARD_STAMPS: StampPreset[] = [
  { name: "Approved", label: "stamps.approved", color: "#2e7d32" },
  { name: "NotApproved", label: "stamps.notApproved", color: "#c62828" },
  { name: "Draft", label: "stamps.draft", color: "#1565c0" },
  { name: "Final", label: "stamps.final", color: "#2e7d32" },
  { name: "Confidential", label: "stamps.confidential", color: "#c62828" },
  { name: "ForComment", label: "stamps.forComment", color: "#1565c0" },
  { name: "ForPublicRelease", label: "stamps.forPublicRelease", color: "#2e7d32" },
  { name: "NotForPublicRelease", label: "stamps.notForPublicRelease", color: "#c62828" },
  { name: "Completed", label: "stamps.completed", color: "#2e7d32" },
  { name: "Void", label: "stamps.void", color: "#c62828" },
];

export const DYNAMIC_STAMPS: StampPreset[] = [
  { name: "Reviewed", label: "stamps.reviewed", color: "#1565c0", dynamic: true },
  { name: "Received", label: "stamps.received", color: "#1565c0", dynamic: true },
  { name: "Approved", label: "stamps.approved", color: "#2e7d32", dynamic: true },
  { name: "Rejected", label: "stamps.rejected", color: "#c62828", dynamic: true },
  { name: "Confidential", label: "stamps.confidential", color: "#c62828", dynamic: true },
];

export const SIGN_HERE_STAMPS: StampPreset[] = [
  { name: "SignHere", label: "stamps.signHere", color: "#c62828" },
  { name: "Witness", label: "stamps.witness", color: "#ef6c00" },
  { name: "InitialHere", label: "stamps.initialHere", color: "#2e7d32" },
];

export function dynamicSublabel(author: string, locale: string, date = new Date()): string {
  const when = date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  return author ? `${author}, ${when}` : when;
}

/** Default stamp size in points for a label (wider for longer labels). */
export function stampSize(label: string, hasSublabel: boolean): [number, number] {
  const width = Math.min(260, Math.max(110, 18 + label.length * 11));
  return [width, hasSublabel ? 50 : 38];
}
