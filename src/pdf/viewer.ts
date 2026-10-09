/**
 * pdf.js viewer components. `pdf_viewer.mjs` reads `globalThis.pdfjsLib` while it is being
 * evaluated, so the core library (imported by ./pdfjs) must be evaluated first — ES modules
 * evaluate dependencies in declaration order, which this file guarantees.
 */
import "./pdfjs";

export {
  EventBus,
  FindState,
  GenericL10n,
  LinkTarget,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from "pdfjs-dist/web/pdf_viewer.mjs";
