/**
 * Unified error model.
 *
 * Errors can originate from the Rust side (serialised `{ code, message, detail }`), from
 * pdf.js (PasswordException, InvalidPDFException, ...) or from the front-end itself. They are
 * all normalised into {@link AppError} so the UI can display a localised message keyed by
 * `code` and still offer the technical detail.
 */

export type ErrorCode =
  | "NOT_FOUND"
  | "PERMISSION_DENIED"
  | "FILE_LOCKED"
  | "READ_ONLY"
  | "DISK_FULL"
  | "NOT_PDF"
  | "EMPTY_FILE"
  | "TOO_LARGE"
  | "FILE_CHANGED"
  | "UNKNOWN_SESSION"
  | "PASSWORD"
  | "OWNER_PASSWORD"
  | "PDF_ERROR"
  | "INVALID_PDF"
  | "UNSUPPORTED"
  | "INVALID_ARGUMENT"
  | "IO_ERROR"
  | "CANCELLED"
  | "RENDER_ERROR"
  | "PRINT_ERROR"
  | "CLIPBOARD"
  | "PERMISSION_RESTRICTED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  override readonly cause?: unknown;

  constructor(code: ErrorCode, message: string, detail?: string, cause?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
    this.cause = cause;
  }

  get isCancellation(): boolean {
    return this.code === "CANCELLED";
  }
}

const KNOWN_CODES = new Set<string>([
  "NOT_FOUND",
  "PERMISSION_DENIED",
  "FILE_LOCKED",
  "READ_ONLY",
  "DISK_FULL",
  "NOT_PDF",
  "EMPTY_FILE",
  "TOO_LARGE",
  "FILE_CHANGED",
  "UNKNOWN_SESSION",
  "PASSWORD",
  "OWNER_PASSWORD",
  "PDF_ERROR",
  "INVALID_PDF",
  "UNSUPPORTED",
  "INVALID_ARGUMENT",
  "IO_ERROR",
  "CANCELLED",
  "RENDER_ERROR",
  "PRINT_ERROR",
  "CLIPBOARD",
  "PERMISSION_RESTRICTED",
  "INTERNAL",
]);

function isRustError(value: unknown): value is { code: string; message: string; detail?: string | null } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** Normalise anything thrown into an {@link AppError}. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (isRustError(err)) {
    const code = (KNOWN_CODES.has(err.code) ? err.code : "INTERNAL") as ErrorCode;
    return new AppError(code, err.message, err.detail ?? undefined, err);
  }
  if (err instanceof Error) {
    switch (err.name) {
      case "PasswordException":
        return new AppError("PASSWORD", err.message, undefined, err);
      case "InvalidPDFException":
        return new AppError("INVALID_PDF", err.message, undefined, err);
      case "ResponseException":
      case "UnknownErrorException":
        return new AppError("PDF_ERROR", err.message, undefined, err);
      case "AbortException":
      case "AbortError":
      case "RenderingCancelledException":
        return new AppError("CANCELLED", err.message, undefined, err);
    }
    return new AppError("INTERNAL", err.message, err.stack, err);
  }
  if (typeof err === "string") return new AppError("INTERNAL", err);
  return new AppError("INTERNAL", "Unknown error", safeStringify(err), err);
}

export function cancelled(message = "Cancelled"): AppError {
  return new AppError("CANCELLED", message);
}

export function isCancellation(err: unknown): boolean {
  return toAppError(err).isCancellation;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
