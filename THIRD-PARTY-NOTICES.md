# Third-party notices

YetAnotherPDFReader is released under the [MIT License](LICENSE). It is built on the open-source
components listed below, each under its own licence. The full licence texts ship with the
respective packages (`node_modules/<package>/LICENSE`, `~/.cargo/registry/src/*/<crate>/LICENSE*`).

## Bundled in the application

| Component | Used for | Licence |
| --- | --- | --- |
| [pdf.js / pdfjs-dist](https://github.com/mozilla/pdf.js) | PDF rendering, text layer, forms | Apache-2.0 |
| pdf.js CMaps (Adobe) | CJK character maps | BSD-3-Clause (Adobe) |
| pdf.js standard fonts | Fallback fonts (Foxit, Liberation) | BSD-style (Foxit), SIL OFL 1.1 (Liberation) |
| pdf.js WebAssembly decoders | JPEG 2000 (OpenJPEG), JBIG2 (PDFium), colour management (qcms) | BSD-2-Clause, BSD-3-Clause, MIT |
| pdf.js ICC profile | CMYK colour conversion | CC0-1.0 |
| [React, React DOM](https://react.dev/) | User interface | MIT |
| [Zustand](https://github.com/pmndrs/zustand) | State management | MIT |
| [Lucide](https://lucide.dev/) | Icons | ISC |
| [Tauri](https://tauri.app/) and its plugins (dialog, opener, log, single-instance, window-state) | Application shell | MIT OR Apache-2.0 |
| [lopdf](https://github.com/J-F-Liu/lopdf) | Reading and writing PDF objects | MIT |
| [arboard](https://github.com/1Password/arboard) | Writing snapshot images to the clipboard | MIT OR Apache-2.0 |
| [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR) PP-OCRv6 tiny models | Text recognition models (`src-tauri/ocr/`) | Apache-2.0 |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | Running the OCR models (static on Windows, `libonnxruntime.so` in the Linux packages) | MIT |
| [oar-ocr](https://github.com/GreatV/oar-ocr), [ort](https://github.com/pykeio/ort) | OCR pipeline and ONNX Runtime bindings | Apache-2.0; MIT OR Apache-2.0 |
| [serde](https://serde.rs/), serde_json, chrono, log and other Rust crates | Serialisation, dates, logging, … | MIT and/or Apache-2.0 |

## Licence summary of all Rust dependencies

All crates in `Cargo.lock` use permissive or weak-copyleft licences: MIT, Apache-2.0 (some with
the LLVM exception), BSD-2-Clause, BSD-3-Clause, ISC, Zlib, BSL-1.0, Unlicense, 0BSD, CC0-1.0,
Unicode-3.0, MPL-2.0 and CDLA-Permissive-2.0 (`webpki-root-certs`, certificate data used
when downloading ONNX Runtime at build time). The MPL-2.0 crates (`cssparser`, `selectors`, `dtoa-short`,
`option-ext`) are used unmodified; their source code is available from crates.io.

To regenerate a full list:

```bash
cargo metadata --format-version 1 | jq -r '.packages[] | "\(.name) \(.version) \(.license)"' | sort
npx license-checker --production --summary
```
