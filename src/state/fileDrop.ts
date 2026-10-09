/**
 * Routing of files dragged from the file manager. By default dropped PDFs are opened; views
 * can take over (the page organizer inserts the files where they are dropped, the insert
 * dialog adds them to its list). The most recently installed target wins.
 */

export interface FileDropTarget {
  /** Label shown in the drop hint while dragging over the window. */
  label: () => string;
  over: (paths: string[], x: number, y: number) => void;
  leave: () => void;
  drop: (paths: string[], x: number, y: number) => void;
}

const stack: FileDropTarget[] = [];

/** Install `next` as the drop target; returns a function that removes it again. */
export function setFileDropTarget(next: FileDropTarget): () => void {
  stack.push(next);
  return () => {
    const i = stack.lastIndexOf(next);
    if (i >= 0) stack.splice(i, 1);
  };
}

export function fileDropTarget(): FileDropTarget | null {
  return stack[stack.length - 1] ?? null;
}
