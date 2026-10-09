# 更新日志 · Changelog

[简体中文](#简体中文) · [English](#english)

## 简体中文

### v0.2.0 — 页面编辑、合并、水印与密码保护

**新功能**

- **页面管理**（`Ctrl+Shift+O`）：在大缩略图网格中管理页面，缩略图大小可调。
  - 单击、Ctrl / Shift+单击多选，方向键浏览，拖动排序；拖到窗口边缘时自动滚动。
  - 悬停时显示旋转、删除按钮，页面之间的「+」可在该处插入；最后一格是「添加页面」。
  - 右键菜单和快捷键：`R` 旋转、`Ctrl+D` 复制、`Delete` 删除、`Esc` 退出。
  - 可以从资源管理器把 PDF 或图片直接拖到两页之间插入。
- **合并多个 PDF 和图片**：一次插入多个文件（JPG、PNG、WebP、GIF、BMP），可调整顺序，并为每个 PDF 选择页码范围。
  - 图片可保持原始尺寸，或适应 A4、Letter、当前页尺寸，可选边距，横竖方向自动匹配。
  - JPEG 照片不重新压缩，并按 EXIF 方向自动摆正。
- **旋转与翻转**：旋转选中页面或全部页面（顺时针、逆时针、180°）；水平或垂直翻转页面，批注位置同步调整。
- **复制、替换、拆分**：复制页面（连同批注）；用其他 PDF 或图片替换页面；按每 N 页、平均分成 N 份或自定义范围拆分文档。
- **水印**：文字水印（支持中文、多行、加粗、颜色）或图片水印。
  - 可调不透明度、角度，位置可选九宫格中的一格或平铺整页，可置于内容上方或下方。
  - 实时预览，并记住上次的设置。
- **密码保护**：AES-256 加密。
  - 可设置打开密码，或用权限密码限制打印、复制、批注和修改。
  - 有密码强度提示；输入权限密码可在本次会话中解除限制；可一键移除保护。
  - 保存前都可以撤销。

**新平台**

- **Linux 版本**：提供 deb、rpm 和 AppImage（x86_64，glibc 2.35+）。

**改进**

- 加密文档在页面操作或撤销后不再重复要求输入密码。
- 剪贴板被其他程序短暂占用时，截图会自动重试复制；在 Linux 上截图会一直留在剪贴板中。
- README 新增页面管理、水印和密码保护的截图与说明。

### v0.1.0 — 首个 Windows 版本

- 多标签阅读、多种页面布局、书签和缩略图、全文搜索、夜间阅读模式。
- 完整的批注与签名，可编辑文件中原有的批注；页面整理；增量保存。
- 框选截图、9 种界面语言、命令面板、自定义快捷键。
- 安装版、MSI 和便携版。

## English

### v0.2.0 — Page editing, merging, watermarks and passwords

**New**

- **Page organizer** (`Ctrl+Shift+O`): manage pages in a large, resizable thumbnail grid.
  - Multi-select with Ctrl / Shift and the arrow keys; drag to reorder, with auto-scroll near the edges.
  - Hover buttons rotate or delete a page, and a "+" between pages inserts there; the last tile adds pages.
  - Context menu and shortcuts: `R` rotate, `Ctrl+D` duplicate, `Delete`, `Esc` to close.
  - Drop PDFs or pictures from Explorer between two pages to insert them.
- **Combine PDFs and pictures**: insert several files at once (JPG, PNG, WebP, GIF, BMP), reorder them and pick page ranges per PDF.
  - Pictures keep their own size or fit A4, Letter or the current page, with an optional margin and matching orientation.
  - JPEG photos are embedded unchanged and turned upright (EXIF).
- **Rotate and flip**: rotate selected or all pages (clockwise, counterclockwise, 180°); mirror pages horizontally or vertically, with comments moved along.
- **Duplicate, replace, split**: duplicate pages with their comments; replace pages by other PDFs or pictures; split a document every N pages, into N files or by custom ranges.
- **Watermarks**: text (CJK, several lines, bold, colour) or picture.
  - Opacity, angle, nine positions or tiled, above or behind the content.
  - Live preview, and the last settings are remembered.
- **Password protection**: AES-256.
  - Set an open password, or restrict printing, copying, comments and editing with a permissions password.
  - Strength meter; enter the permissions password to lift restrictions for the session; remove protection in one step.
  - Everything can be undone until you save.

**New platform**

- **Linux builds**: deb, rpm and AppImage (x86_64, glibc 2.35+).

**Improved**

- Protected documents no longer ask for their password again after page operations or undo.
- Snapshots retry when another program briefly holds the clipboard, and stay on the Linux clipboard.
- README: screenshots and descriptions of the organizer, watermarks and password protection.

### v0.1.0 — First Windows release

- Tabs, page layouts, bookmarks and thumbnails, full-text search, night reading modes.
- Full commenting and signatures, editable existing comments, page organisation, incremental saving.
- Region snapshots, 9 UI languages, command palette, customisable shortcuts.
- Installer, MSI and portable builds.
