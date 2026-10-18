# OCR models

PaddleOCR **PP-OCRv6 tiny** text detection and recognition models (ONNX export) with their
character dictionary (6 904 characters: Chinese, English letters, digits and punctuation).

| File | Size | SHA-256 |
| --- | --- | --- |
| `pp-ocrv6_tiny_det.onnx` | 1.7 MiB | `193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8` |
| `pp-ocrv6_tiny_rec.onnx` | 4.3 MiB | `9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6` |
| `ppocrv6_tiny_dict.txt` | 27 KiB | `c5cbe34ef40c29c4df07ed012bf96569cb69a2d2a01a07027e9f13cb832bd9cd` |

- Source: PaddlePaddle / PaddleOCR (https://github.com/PaddlePaddle/PaddleOCR), ONNX exports
  published by the oar-ocr project (https://github.com/GreatV/oar-ocr/releases/tag/v0.7.0).
- License: Apache License 2.0.

The models are compiled into the application (`include_bytes!` in `src/ocr.rs`), so OCR works
offline and the portable build stays a single executable.

## ONNX Runtime

Windows and Apple silicon Macs link ONNX Runtime statically (prebuilt by the `ort` crate).
Linux and Intel Macs load Microsoft's official shared library (1.22.0) at run time instead:
`scripts/build-linux.sh` puts `libonnxruntime.so` in `ocr/linux/` for the packages, and the
Release workflow puts `libonnxruntime.dylib` in `ocr/macos/` for the Intel Mac app
(`Contents/Frameworks/`). When running from source there, point `ORT_DYLIB_PATH` at the library.
