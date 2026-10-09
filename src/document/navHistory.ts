/**
 * Back / forward navigation history ("previous view" in Acrobat). Implements the subset of
 * pdf.js' `PDFHistory` interface used by `PDFLinkService`, without touching `window.history`
 * (several documents live in one window).
 */

export interface ViewLocation {
  pageNumber: number;
  /** pdf.js destination array used to restore the exact position. */
  dest: unknown[] | null;
}

const MAX_ENTRIES = 100;

export class NavHistory {
  private back: ViewLocation[] = [];
  private forward: ViewLocation[] = [];
  private navigating = false;

  constructor(
    private readonly current: () => ViewLocation | null,
    private readonly goTo: (loc: ViewLocation) => void,
    private readonly onChange: () => void,
  ) {}

  get canGoBack(): boolean {
    return this.back.length > 0;
  }

  get canGoForward(): boolean {
    return this.forward.length > 0;
  }

  /** Called by the link service before jumping to a destination. */
  pushCurrentPosition(): void {
    if (this.navigating) return;
    const loc = this.current();
    if (!loc) return;
    const last = this.back.at(-1);
    if (last && last.pageNumber === loc.pageNumber && JSON.stringify(last.dest) === JSON.stringify(loc.dest)) return;
    this.back.push(loc);
    if (this.back.length > MAX_ENTRIES) this.back.shift();
    this.forward = [];
    this.onChange();
  }

  // The link service also reports where it is going; we record positions lazily instead.
  push(_target: unknown): void {}
  pushPage(_pageNumber: number): void {}

  goBack(): void {
    const target = this.back.pop();
    if (!target) return;
    const here = this.current();
    if (here) this.forward.push(here);
    this.navigate(target);
  }

  goForward(): void {
    const target = this.forward.pop();
    if (!target) return;
    const here = this.current();
    if (here) this.back.push(here);
    this.navigate(target);
  }

  private navigate(loc: ViewLocation) {
    this.navigating = true;
    try {
      this.goTo(loc);
    } finally {
      this.navigating = false;
      this.onChange();
    }
  }

  clear(): void {
    this.back = [];
    this.forward = [];
    this.onChange();
  }

  /** Adapter object handed to `PDFLinkService.setHistory`. */
  asPdfHistory() {
    return {
      pushCurrentPosition: () => this.pushCurrentPosition(),
      push: (t: unknown) => this.push(t),
      pushPage: (p: number) => this.pushPage(p),
      back: () => this.goBack(),
      forward: () => this.goForward(),
    };
  }
}
