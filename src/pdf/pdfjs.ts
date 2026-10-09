/**
 * pdf.js bootstrap: worker, static resources and document loading.
 *
 * All documents share ONE worker thread, which keeps memory usage flat when many tabs are open.
 * Files above the "stream threshold" are loaded through a range transport backed by the Rust
 * session, so only the parts that are actually displayed are read from disk.
 */
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import { api, type DocInfo } from "../lib/ipc";
import { AppError, cancelled, toAppError } from "../lib/errors";
import { createLogger } from "../lib/log";

const log = createLogger("pdfjs");

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjs };
export type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

const assetUrl = (path: string) => new URL(`/pdfjs/${path}/`, window.location.href).href;

let sharedWorker: pdfjs.PDFWorker | null = null;

export function getSharedWorker(): pdfjs.PDFWorker {
  if (!sharedWorker || sharedWorker.destroyed) {
    sharedWorker = new pdfjs.PDFWorker();
  }
  return sharedWorker;
}

/** Size of the chunks requested from disk for streamed documents. */
const RANGE_CHUNK = 1 << 20;

/**
 * Range transport reading byte ranges on demand from the Rust document session. Failed reads
 * are retried once; persistent failures (e.g. the file was rewritten by another program) are
 * reported through `onError` so the UI can offer to reload the document.
 */
class SessionRangeTransport extends pdfjs.PDFDataRangeTransport {
  private aborted = false;

  constructor(
    private readonly sessionId: number,
    length: number,
    initialData: Uint8Array,
    private readonly onError: (err: AppError) => void,
  ) {
    super(length, initialData);
  }

  override requestDataRange(begin: number, end: number): void {
    const attempt = (retry: boolean) => {
      api
        .docRead(this.sessionId, begin, end)
        .then((buf) => {
          if (!this.aborted) this.onDataRange(begin, new Uint8Array(buf));
        })
        .catch((err) => {
          const appErr = toAppError(err);
          if (retry && appErr.code !== "FILE_CHANGED" && appErr.code !== "UNKNOWN_SESSION") {
            attempt(false);
            return;
          }
          log.error(`range ${begin}-${end} failed`, appErr.message);
          if (!this.aborted) this.onError(appErr);
        });
    };
    attempt(true);
  }

  override abort(): void {
    this.aborted = true;
    super.abort();
  }
}

export type PasswordReason = "need" | "incorrect";

export interface LoadOptions {
  /** Ask the user for a password; resolve `null` to cancel opening. */
  onPassword: (reason: PasswordReason) => Promise<string | null>;
  onProgress?: (loaded: number, total: number) => void;
  /** Persistent read failure while streaming. */
  onStreamError?: (err: AppError) => void;
  streamThresholdBytes: number;
  prefetchAll: boolean;
  useSystemFonts: boolean;
  enableXfa: boolean;
  enableHWA: boolean;
}

export type DocumentSource =
  | { kind: "session"; info: DocInfo }
  | { kind: "data"; data: Uint8Array };

export interface LoadedDocument {
  pdf: PDFDocumentProxy;
  task: PDFDocumentLoadingTask;
  /** Password that unlocked the document (needed by the Rust writer), or null. */
  password: string | null;
  streamed: boolean;
}

function commonParams(opts: LoadOptions) {
  return {
    worker: getSharedWorker(),
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetUrl("standard_fonts"),
    wasmUrl: assetUrl("wasm"),
    iccUrl: assetUrl("iccs"),
    useSystemFonts: opts.useSystemFonts,
    enableXfa: opts.enableXfa,
    enableHWA: opts.enableHWA,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  };
}

/** Load a document, handling password prompts. Throws {@link AppError} (CANCELLED if the user aborts). */
export async function loadDocument(source: DocumentSource, opts: LoadOptions): Promise<LoadedDocument> {
  let task: PDFDocumentLoadingTask;
  let streamed = false;

  if (source.kind === "session") {
    const { info } = source;
    if (info.size > opts.streamThresholdBytes) {
      streamed = true;
      const initialLen = Math.min(info.size, RANGE_CHUNK);
      const initial = new Uint8Array(await api.docRead(info.sessionId, 0, initialLen));
      const transport = new SessionRangeTransport(info.sessionId, info.size, initial, (err) =>
        opts.onStreamError?.(err),
      );
      task = pdfjs.getDocument({
        ...commonParams(opts),
        range: transport,
        rangeChunkSize: RANGE_CHUNK,
        disableAutoFetch: !opts.prefetchAll,
        disableStream: true,
      });
    } else {
      const data = new Uint8Array(await api.docReadAll(info.sessionId));
      task = pdfjs.getDocument({ ...commonParams(opts), data });
    }
  } else {
    task = pdfjs.getDocument({ ...commonParams(opts), data: source.data });
  }

  let password: string | null = null;
  let userCancelled = false;
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    const why: PasswordReason = reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? "incorrect" : "need";
    opts.onPassword(why).then(
      (pw) => {
        if (pw === null) {
          userCancelled = true;
          void task.destroy();
          return;
        }
        password = pw;
        update(pw);
      },
      () => {
        userCancelled = true;
        void task.destroy();
      },
    );
  };
  if (opts.onProgress) {
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => opts.onProgress?.(loaded, total);
  }

  try {
    const pdf = await task.promise;
    return { pdf, task, password, streamed };
  } catch (err) {
    if (userCancelled) throw cancelled("password prompt cancelled");
    throw toAppError(err);
  }
}
