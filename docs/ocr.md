# 文字识别（OCR）方案 · Text recognition (OCR)

[简体中文](#简体中文) · [English](#english)

## 简体中文

### 选型结论

YAPR 使用 **PaddleOCR PP-OCRv6 tiny**（Apache-2.0），通过 **ONNX Runtime** 在本机 CPU 上运行。模型编译进程序，完全离线，不上传任何内容。

| 候选方案 | 中英文准确率 | 速度 | 体积 | 离线 | 结论 |
| --- | --- | --- | --- | --- | --- |
| **PaddleOCR PP-OCRv6 tiny**（ONNX） | 很高 | 很快 | 模型约 6 MB | ✅ | **采用** |
| PaddleOCR PP-OCRv5 mobile（ONNX） | 很高（与 v6 tiny 相当） | 慢约 4 倍 | 模型约 21 MB | ✅ | 无明显优势 |
| PaddleOCR PP-OCRv5 server | 更高 | 慢得多 | 模型约 165 MB | ✅ | 体积过大 |
| Tesseract 4/5 | 英文好，中文和扫描件明显较差 | 慢 | 中文数据数十 MB | ✅ | 不采用 |
| ocrs（纯 Rust） | 仅支持拉丁字母 | 快 | 小 | ✅ | 不支持中文 |
| Windows.Media.Ocr / macOS Vision | 中等，依赖系统语言包 | 快 | 0 | ✅ | 不跨平台 |
| PaddleOCR-VL、Qwen-VL 等大模型 | 版面理解最好 | 需要 GPU | 数 GB | ✅ | 不适合桌面阅读器 |
| 云端 OCR 服务 | 高 | 取决于网络 | 0 | ❌ | 违背离线与隐私原则 |

### 实测数据

测试集：由示例文档渲染的 8 张页面图像（150 dpi），中英文混排，每页一张清晰版和一张「扫描版」（灰度、旋转 0.8°、模糊、噪点、JPEG 压缩）；以 PDF 自身的文字层作为标准答案。

| 引擎 | 字符错误率（CER） | 中文扫描页 CER | 平均每页耗时 |
| --- | --- | --- | --- |
| **PP-OCRv6 tiny** | **2.55%** | **0.00%** | **0.17 秒** |
| PP-OCRv5 mobile | 2.42% | 1.20% | 0.68 秒 |
| Tesseract 4.1（chi_sim+eng） | 4.77% | 10.82% | 1.14 秒 |

说明：PP-OCR 剩余的「错误」主要来自图表中的坐标文字。这些文字在图片里，PDF 文字层中没有，所以识别出来反而被算作多余字符。不计阅读顺序时，PP-OCRv6 tiny 在文字页上的字符 F1 为 99.96%–100%。

### 在 YAPR 中的实现

- **Rust 端**（`src-tauri/src/ocr.rs`）：首次使用时创建识别引擎（约 0.1 秒），之后复用，按阅读顺序输出文字行及其四个角点。
  - Windows 静态链接 ONNX Runtime。
  - Linux 在运行时加载随安装包附带的官方 `libonnxruntime.so`（1.22，支持 glibc 2.27 以上）。
- **PDF 写入**（`crates/yapr-pdf/src/text_layer.rs`）：把识别结果以不可见文字（渲染模式 3）写入页面，位置与图像中的文字完全重合，因此扫描件可以搜索、选择和复制，页面外观不变。写入方式是增量更新，可以撤销。
- **界面**：
  - 「框选识别文字」（`Ctrl+Alt+T`）：拖动框选区域，在对话框中查看、修改并复制识别结果。
  - 「文字识别（OCR）」：识别整个文档或指定页面，默认跳过已有文字的页面，显示进度和剩余时间，可随时取消。
  - 打开扫描文档时自动提示可以进行识别。这个提示可以在「设置 ▸ 阅读」中关闭。
- **测试**：
  - Rust：识别中英文混排和噪声扫描图、文字层写入及 pdf.js 能否提取文字。
  - 前端单元测试：文字行拼接。
  - 端到端测试 `npm run test:ocr`：在真实应用中打开扫描 PDF，依次验证识别提示、框选识别、整篇识别、搜索，以及保存后的文件内容。

## English

### Decision

YAPR uses **PaddleOCR PP-OCRv6 tiny** (Apache-2.0) on **ONNX Runtime**, on the local CPU. The models are compiled into the application, so OCR works offline and nothing is uploaded.

| Option | Accuracy (zh/en) | Speed | Size | Offline | Verdict |
| --- | --- | --- | --- | --- | --- |
| **PaddleOCR PP-OCRv6 tiny** (ONNX) | very high | very fast | ~6 MB models | ✅ | **chosen** |
| PaddleOCR PP-OCRv5 mobile (ONNX) | very high (on par) | ~4× slower | ~21 MB | ✅ | no advantage |
| PaddleOCR PP-OCRv5 server | higher | much slower | ~165 MB | ✅ | too large |
| Tesseract 4/5 | good English, clearly weaker on Chinese and scans | slow | tens of MB for Chinese | ✅ | not chosen |
| ocrs (pure Rust) | Latin script only | fast | small | ✅ | no Chinese |
| Windows.Media.Ocr / macOS Vision | medium, needs system language packs | fast | 0 | ✅ | not cross-platform |
| PaddleOCR-VL, Qwen-VL and other VLMs | best layout understanding | needs a GPU | GBs | ✅ | too heavy for a reader |
| Cloud OCR | high | network-bound | 0 | ❌ | breaks offline / privacy |

### Measurements

Eight page images (150 dpi) rendered from the sample documents, mixed Chinese and English, each clean and "scanned" (grey, rotated 0.8°, blurred, noisy, JPEG). Ground truth is the PDF's own text.

| Engine | CER | CER, Chinese scan | Time per page |
| --- | --- | --- | --- |
| **PP-OCRv6 tiny** | **2.55%** | **0.00%** | **0.17 s** |
| PP-OCRv5 mobile | 2.42% | 1.20% | 0.68 s |
| Tesseract 4.1 (chi_sim+eng) | 4.77% | 10.82% | 1.14 s |

Most remaining PP-OCR "errors" are axis labels inside a chart picture. They are correctly recognised, but absent from the PDF text used as ground truth. Ignoring reading order, PP-OCRv6 tiny scores a character F1 of 99.96–100% on text pages.

### Implementation

- **Rust** (`src-tauri/src/ocr.rs`): the engine is created on first use (~0.1 s) and reused. It returns lines in reading order with their four corners.
  - ONNX Runtime is linked statically on Windows.
  - On Linux, the official `libonnxruntime.so` (1.22, glibc 2.27+) shipped in the packages is loaded at run time.
- **PDF** (`crates/yapr-pdf/src/text_layer.rs`): recognised lines are written as invisible text (rendering mode 3) exactly over the picture. Scanned pages become searchable, selectable and copyable without looking different. It is written as an incremental update and can be undone.
- **UI**:
  - *Recognize Text in Region* (`Ctrl+Alt+T`): drag over text, then check, edit and copy the result.
  - *Recognize Text (OCR)*: process the whole document or chosen pages; pages that already have text are skipped by default. Shows progress and time left, and can be cancelled.
  - A suggestion appears when a scanned document is opened. It can be turned off in *Settings ▸ Reading*.
- **Tests**:
  - Rust: mixed Chinese/English and noisy scan recognition, writing the text layer, and checking pdf.js can extract it.
  - Front-end unit tests: line assembly.
  - End-to-end `npm run test:ocr`: in the real app, opens a scanned PDF and checks the suggestion, region OCR, whole-document OCR, find, and the saved file.
