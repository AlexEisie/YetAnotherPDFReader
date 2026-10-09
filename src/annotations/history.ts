/**
 * Undo / redo history of a document.
 *
 * Two command types exist:
 * * `annotations` — a list of `{ id, before, after }` replacements on the annotation model
 *   (add: before = null, delete: after = null). Consecutive commands with the same `mergeKey`
 *   (e.g. dragging an opacity slider, typing in a note) are merged into one undo step.
 * * `base` — a structural page operation that replaced the underlying PDF bytes. It stores the
 *   complete model state before and after so it can be swapped back exactly.
 */
import type { Annotation } from "./model";
import type { InfoUpdate } from "./dto";

export interface Change {
  id: string;
  before: Annotation | null;
  after: Annotation | null;
}

export interface ModelSnapshot {
  items: Record<string, Annotation>;
  pristine: Record<string, Annotation>;
}

export interface BaseState {
  bytes: Uint8Array;
  model: ModelSnapshot;
  /** Pending metadata overrides relative to these bytes. */
  info: InfoUpdate | null;
  /** Page shown when this state becomes active again. */
  page: number;
  /** Passwords that open these bytes (undefined: same as the current document). */
  password?: string | null;
  ownerPassword?: string | null;
}

interface CommandBase {
  seq: number;
  label: string;
  time: number;
}

export interface AnnotationCommand extends CommandBase {
  type: "annotations";
  changes: Change[];
  mergeKey?: string;
}

export interface BaseCommand extends CommandBase {
  type: "base";
  before: BaseState;
  after: BaseState;
}

export type Command = AnnotationCommand | BaseCommand;

const MAX_COMMANDS = 1000;
/** Base commands hold whole documents in memory; keep only the most recent few. */
const MAX_BASE_COMMANDS = 8;
const MERGE_WINDOW_MS = 1500;

export interface HistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  dirty: boolean;
}

export class History {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private seq = 0;
  /** `seq` of the top undo command when the document was last saved (0 = empty stack). */
  private savedSeq = 0;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    for (const l of this.listeners) l();
  }

  private get topSeq(): number {
    return this.undoStack.at(-1)?.seq ?? 0;
  }

  get state(): HistoryState {
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: this.undoStack.at(-1)?.label ?? null,
      redoLabel: this.redoStack.at(-1)?.label ?? null,
      dirty: this.topSeq !== this.savedSeq,
    };
  }

  get dirty(): boolean {
    return this.topSeq !== this.savedSeq;
  }

  pushAnnotations(label: string, changes: Change[], mergeKey?: string): void {
    const meaningful = changes.filter((c) => c.before !== c.after);
    if (meaningful.length === 0) return;
    const top = this.undoStack.at(-1);
    const now = Date.now();
    if (
      mergeKey &&
      top?.type === "annotations" &&
      top.mergeKey === mergeKey &&
      now - top.time < MERGE_WINDOW_MS &&
      // Never merge into the saved state, otherwise "dirty" tracking would be wrong.
      top.seq !== this.savedSeq
    ) {
      for (const change of meaningful) {
        const existing = top.changes.find((c) => c.id === change.id);
        if (existing) existing.after = change.after;
        else top.changes.push(change);
      }
      top.time = now;
      this.redoStack = [];
      this.emit();
      return;
    }
    this.push({ type: "annotations", seq: ++this.seq, label, time: now, changes: meaningful, mergeKey });
  }

  pushBase(label: string, before: BaseState, after: BaseState): void {
    this.push({ type: "base", seq: ++this.seq, label, time: Date.now(), before, after });
  }

  private push(cmd: Command) {
    this.undoStack.push(cmd);
    this.redoStack = [];
    this.trim();
    this.emit();
  }

  private trim() {
    while (this.undoStack.length > MAX_COMMANDS) this.undoStack.shift();
    let bases = this.undoStack.filter((c) => c.type === "base").length;
    while (bases > MAX_BASE_COMMANDS) {
      // Drop everything up to and including the oldest base command: earlier commands refer to
      // a document state that can no longer be restored.
      const idx = this.undoStack.findIndex((c) => c.type === "base");
      this.undoStack.splice(0, idx + 1);
      bases--;
    }
  }

  /** Pop the last command; the caller applies its inverse. */
  undo(): Command | null {
    const cmd = this.undoStack.pop() ?? null;
    if (cmd) {
      this.redoStack.push(cmd);
      this.emit();
    }
    return cmd;
  }

  redo(): Command | null {
    const cmd = this.redoStack.pop() ?? null;
    if (cmd) {
      this.undoStack.push(cmd);
      this.emit();
    }
    return cmd;
  }

  markSaved(): void {
    this.savedSeq = this.topSeq;
    this.emit();
  }

  /** Forget everything (document reloaded from disk). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.savedSeq = 0;
    this.emit();
  }
}

/** Inverse of an annotations command, as a list of changes to apply. */
export function invertChanges(changes: Change[]): Change[] {
  return changes.map((c) => ({ id: c.id, before: c.after, after: c.before })).reverse();
}
