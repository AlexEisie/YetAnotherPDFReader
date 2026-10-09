/** Process-wide application info received from the Rust side at startup. */
import type { AppInfo } from "../lib/ipc";

let info: AppInfo | null = null;

export function setAppInfo(value: AppInfo): void {
  info = value;
}

export function appInfo(): AppInfo | null {
  return info;
}
