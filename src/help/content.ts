/**
 * In-app user guide. Text is written in Simplified Chinese and English; the other interface
 * languages show the English guide. Inline markup: `**bold**`, `` `key` `` (shown as a key),
 * lines starting with "- " become list items. `commands` lists command ids shown as buttons
 * that run the command (with their current shortcut).
 */
import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  CircleHelp,
  FileScan,
  Info,
  Keyboard,
  LayoutGrid,
  Lock,
  MessageSquareText,
  Rocket,
  Save,
} from "lucide-react";

export interface HelpBlock {
  title: string;
  body: string;
  commands?: string[];
}

export interface HelpTopic {
  id: string;
  icon: LucideIcon;
  title: string;
  summary: string;
  blocks: HelpBlock[];
  /** Rendered by the help view itself (shortcut list, about & updates). */
  special?: "shortcuts" | "about";
}

type Lang = "zh" | "en";

const ZH: HelpTopic[] = [
  {
    id: "start",
    icon: Rocket,
    title: "快速上手",
    summary: "打开文档、切换标签、翻页和缩放。",
    blocks: [
      {
        title: "打开文档",
        body: "点击工具栏的打开按钮或按 `Ctrl+O`，也可以把 PDF 拖进窗口。在资源管理器里双击 PDF 会在已打开的窗口中新建标签。\n起始页列出最近打开的文档（带封面），文件被移动或删除时会标出。",
        commands: ["file.open", "help.welcome"],
      },
      {
        title: "多标签",
        body: "每个文档一个标签：拖动可调整顺序，中键关闭，`Ctrl+Tab` 切换，`Ctrl+Shift+T` 重新打开刚关闭的标签。可以在设置中选择启动时恢复上次的文档。",
        commands: ["go.nextTab", "file.reopenClosed"],
      },
      {
        title: "翻页与缩放",
        body: "- 滚轮滚动，`Page Up` / `Page Down` 或空格翻页，`Ctrl+G` 跳到指定页\n- `Ctrl` + 滚轮或触控板双指以鼠标位置为中心缩放\n- `Ctrl+0` 适合页面，`Ctrl+2` 适合宽度，`Ctrl+1` 实际大小",
        commands: ["go.page", "view.fitPage", "view.fitWidth"],
      },
      {
        title: "找到任意功能",
        body: "按 `Ctrl+Shift+P`（或 `Ctrl+K`）打开命令面板，输入功能名称的几个字即可执行。所有快捷键都可以在设置中修改。",
        commands: ["help.commandPalette", "edit.preferences"],
      },
    ],
  },
  {
    id: "reading",
    icon: BookOpen,
    title: "阅读与浏览",
    summary: "页面布局、侧栏、查找、夜间阅读和朗读。",
    blocks: [
      {
        title: "侧栏",
        body: "`F4` 显示或隐藏侧栏，里面有页面缩略图、书签目录、批注列表、附件、图层和全文搜索。书签会自动跟随当前阅读位置。",
        commands: ["view.sidebar", "view.sidebar.outline", "view.sidebar.search"],
      },
      {
        title: "查找",
        body: "`Ctrl+F` 在当前文档中查找，可区分大小写、全字匹配、高亮全部结果；`Enter` / `Shift+Enter` 跳到下一个 / 上一个。侧栏的全文搜索会列出所有结果及上下文。",
        commands: ["edit.find"],
      },
      {
        title: "页面配色与夜间阅读",
        body: "工具栏的月亮按钮可以切换页面配色：深色（反色）、**夜间**（页面变暗但图片保持原色）、棕褐、护眼绿和自定义颜色。`Ctrl+Alt+N` 依次切换。可以在设置中让深色主题自动使用深色页面。",
        commands: ["view.bg.cycle", "view.bg.night"],
      },
      {
        title: "专注阅读",
        body: "阅读模式（`Ctrl+H`）隐藏工具栏；全屏（`F11`）；演示模式（`F5`）支持切换动画和自动翻页；自动滚动适合长文档。",
        commands: ["view.readMode", "view.fullscreen", "view.presentation"],
      },
      {
        title: "朗读",
        body: "使用系统语音朗读当前页或从当前位置开始朗读，可以暂停和停止。可在设置中选择语音和语速。",
        commands: ["tts.readPage", "tts.readFromHere"],
      },
    ],
  },
  {
    id: "comments",
    icon: MessageSquareText,
    title: "批注与签名",
    summary: "高亮、便笺、图形、图章和签名。",
    blocks: [
      {
        title: "批注工具",
        body: "按 `C` 显示批注工具栏。选中文字后会出现浮动工具栏，可以直接高亮、加下划线或删除线。其他工具包括便笺（可回复）、文本框、手绘、橡皮擦、矩形、椭圆、箭头、多边形和图章。",
        commands: ["comment.toolbar"],
      },
      {
        title: "修改批注",
        body: "用选择工具（`V`）点击批注即可移动、缩放、修改颜色、不透明度和线宽；**文件里原有的批注也可以修改**。可以把当前样式设为该工具的默认样式。",
      },
      {
        title: "签名与图章",
        body: "可以手写、键入或使用图片创建签名，保存后重复使用。图章包括标准图章、带姓名和日期的动态图章以及图片图章。",
        commands: ["tool.signature", "tool.image"],
      },
      {
        title: "批注列表",
        body: "右侧批注窗格列出所有批注，可筛选、排序、回复并设置审阅状态；单击即可跳到对应位置。",
        commands: ["view.sidebar.annotations"],
      },
    ],
  },
  {
    id: "pages",
    icon: LayoutGrid,
    title: "页面管理",
    summary: "插入、合并、旋转、翻转、删除、拆分页面。",
    blocks: [
      {
        title: "页面管理视图",
        body: "`Ctrl+Shift+O` 打开页面管理：单击选择，`Ctrl` / `Shift` + 单击多选，拖动调整顺序。悬停在页面上可以直接旋转或删除，页面之间的「+」可在该处插入。快捷键：`R` 旋转、`Ctrl+D` 复制、`Delete` 删除、`Esc` 退出。",
        commands: ["page.organize"],
      },
      {
        title: "合并 PDF 和图片",
        body: "「从文件插入页面」可以一次选择多个 PDF 和图片（JPG、PNG、WebP、GIF、BMP），调整顺序并为每个 PDF 指定页码。图片可以保持原尺寸，或适应 A4、Letter、当前页尺寸。在页面管理中，也可以直接从资源管理器把文件拖到两页之间。",
        commands: ["page.insertFile", "page.insertBlank"],
      },
      {
        title: "旋转、翻转、复制、替换",
        body: "可以旋转选中页面或全部页面，水平或垂直翻转（批注位置会一起调整），复制页面，用其他文件替换页面。",
        commands: ["page.rotateAllCw", "page.flipH", "page.duplicate", "page.replace"],
      },
      {
        title: "提取与拆分",
        body: "提取页面另存为新文件，或按每 N 页、平均 N 份、自定义范围把文档拆分成多个文件。",
        commands: ["page.extract", "page.split"],
      },
      {
        title: "撤销",
        body: "所有页面操作都可以用 `Ctrl+Z` 撤销，直到保存为止。",
        commands: ["edit.undo"],
      },
    ],
  },
  {
    id: "ocr",
    icon: FileScan,
    title: "截图与文字识别",
    summary: "框选截图、框选识别文字、让扫描件可以搜索。",
    blocks: [
      {
        title: "框选截图",
        body: "`Ctrl+Alt+S` 进入截图模式，拖动框选区域，松开后图片直接复制到剪贴板，并可另存为 PNG。图片是按 PDF 重新渲染的，可在设置中选择 150–600 DPI。",
        commands: ["tool.snapshot"],
      },
      {
        title: "框选识别文字",
        body: "`Ctrl+Alt+T` 后框选任意区域（包括扫描件和图片），识别出的文字显示在对话框中，可以修改后复制。",
        commands: ["tool.ocrRegion"],
      },
      {
        title: "让扫描件可以搜索",
        body: "「文字识别（OCR）」为扫描页添加不可见的文字层，之后就能搜索、选择和复制，页面外观不变。默认跳过已有文字的页面，可以随时取消，保存前可以撤销。打开扫描文档时会自动提示。",
        commands: ["doc.ocr"],
      },
      {
        title: "识别能力",
        body: "支持中文和英文印刷体，在本机运行，不会上传任何内容。手写体、艺术字和很小的字可能识别不准；对小字号的扫描件可以选择 300 dpi。",
      },
    ],
  },
  {
    id: "protect",
    icon: Lock,
    title: "水印与密码保护",
    summary: "添加文字或图片水印，设置或移除密码。",
    blocks: [
      {
        title: "水印",
        body: "可以添加文字（支持中文、多行）或图片水印，设置不透明度、角度、位置或平铺整页，放在内容上方或下方，对话框中实时预览。水印写入页面内容，保存前可以撤销。",
        commands: ["doc.watermark"],
      },
      {
        title: "设置密码",
        body: "「密码保护」使用 AES-256 加密：\n- **打开密码**：没有密码无法查看文档\n- **权限密码**：可以禁止打印、复制、批注或修改\n请牢记密码，遗失后无法找回。保护会在保存时写入文件。",
        commands: ["doc.security"],
      },
      {
        title: "移除密码",
        body: "打开文档后选择「移除密码保护」并保存即可。如果文档设置了权限限制，需要输入权限密码。输入权限密码后，本次使用中也会解除这些限制。",
        commands: ["doc.removeSecurity"],
      },
    ],
  },
  {
    id: "saving",
    icon: Save,
    title: "保存与安全",
    summary: "保存方式、备份、崩溃恢复和文档属性。",
    blocks: [
      {
        title: "保存",
        body: "`Ctrl+S` 保存，`Ctrl+Shift+S` 另存为。修改会以增量方式追加到文件末尾，原始内容保持不变，**数字签名不会失效**。写入时先写临时文件再替换，可以在设置中保留 `.bak` 备份。",
        commands: ["file.save", "file.saveAs"],
      },
      {
        title: "崩溃恢复",
        body: "程序会定期保存未保存的批注；意外退出后再次打开文档时可以恢复。",
      },
      {
        title: "外部修改",
        body: "文件被其他程序修改或删除时会提示，可以选择重新载入或保留当前内容。",
        commands: ["file.reload"],
      },
      {
        title: "文档属性",
        body: "`Ctrl+D` 查看和修改标题、作者、主题、关键字，以及安全设置和使用的字体。",
        commands: ["file.properties"],
      },
    ],
  },
  { id: "shortcuts", icon: Keyboard, title: "快捷键", summary: "当前生效的全部快捷键，可在设置中修改。", blocks: [], special: "shortcuts" },
  {
    id: "faq",
    icon: CircleHelp,
    title: "常见问题",
    summary: "安装、便携版、数据位置和疑难解答。",
    blocks: [
      {
        title: "安装时出现 SmartScreen 提示",
        body: "安装包暂未进行代码签名。点击「更多信息」→「仍要运行」即可；发布页列出了每个文件的 SHA-256 校验值。",
      },
      {
        title: "便携版和数据保存在哪里",
        body: "便携版的设置、最近文件、日志都保存在程序旁边的 `data` 文件夹。安装版保存在用户的应用数据目录，可以在「关于与更新」中打开。",
      },
      {
        title: "忘记了 PDF 的密码",
        body: "加密使用 AES-256，忘记打开密码后无法打开文档，本程序也无法破解。",
      },
      {
        title: "Linux 上窗口空白",
        body: "部分显卡驱动或虚拟机中 WebKitGTK 可能无法正常绘制，可以用环境变量 `WEBKIT_DISABLE_DMABUF_RENDERER=1` 启动程序。",
      },
      {
        title: "反馈问题",
        body: "欢迎在 GitHub 的 Issues 中反馈问题或建议。反馈时可以附上日志文件（「帮助 ▸ 打开日志文件夹」）。",
        commands: ["help.logs"],
      },
    ],
  },
  { id: "about", icon: Info, title: "关于与更新", summary: "版本、检查更新、开源协议。", blocks: [], special: "about" },
];

const EN: HelpTopic[] = [
  {
    id: "start",
    icon: Rocket,
    title: "Getting started",
    summary: "Open documents, use tabs, move around and zoom.",
    blocks: [
      {
        title: "Open documents",
        body: "Use the open button or `Ctrl+O`, or drop PDFs on the window. PDFs opened from Explorer get a new tab in the running window.\nThe start page lists recent documents with covers and marks files that were moved or deleted.",
        commands: ["file.open", "help.welcome"],
      },
      {
        title: "Tabs",
        body: "One tab per document: drag to reorder, middle-click to close, `Ctrl+Tab` to switch, `Ctrl+Shift+T` to reopen a closed tab. The last session can be restored at start-up (see Settings).",
        commands: ["go.nextTab", "file.reopenClosed"],
      },
      {
        title: "Navigate and zoom",
        body: "- Scroll with the wheel, `Page Up` / `Page Down` or Space; `Ctrl+G` goes to a page\n- `Ctrl` + wheel or a touchpad pinch zooms around the pointer\n- `Ctrl+0` fit page, `Ctrl+2` fit width, `Ctrl+1` actual size",
        commands: ["go.page", "view.fitPage", "view.fitWidth"],
      },
      {
        title: "Find any feature",
        body: "`Ctrl+Shift+P` (or `Ctrl+K`) opens the command palette: type a few letters of a feature and press Enter. Every shortcut can be changed in Settings.",
        commands: ["help.commandPalette", "edit.preferences"],
      },
    ],
  },
  {
    id: "reading",
    icon: BookOpen,
    title: "Reading",
    summary: "Layouts, sidebar, find, night reading and Read Out Loud.",
    blocks: [
      {
        title: "Sidebar",
        body: "`F4` shows or hides the sidebar with page thumbnails, bookmarks, comments, attachments, layers and full-text search. Bookmarks follow the current position.",
        commands: ["view.sidebar", "view.sidebar.outline", "view.sidebar.search"],
      },
      {
        title: "Find",
        body: "`Ctrl+F` finds text in the document: match case, whole words, highlight all; `Enter` / `Shift+Enter` for next / previous. The sidebar search lists every match with context.",
        commands: ["edit.find"],
      },
      {
        title: "Page colours and night reading",
        body: "The moon button changes page colours: dark (inverted), **night** (dark pages, pictures keep their colours), sepia, eye-care green and custom colours. `Ctrl+Alt+N` cycles through them. Dark pages can follow the dark theme automatically.",
        commands: ["view.bg.cycle", "view.bg.night"],
      },
      {
        title: "Focus",
        body: "Read mode (`Ctrl+H`) hides the toolbars; full screen (`F11`); presentation (`F5`) with transitions and auto-advance; auto scroll for long documents.",
        commands: ["view.readMode", "view.fullscreen", "view.presentation"],
      },
      {
        title: "Read Out Loud",
        body: "Reads the page, or from the current position, with the system voices; pause and stop any time. Choose the voice and speed in Settings.",
        commands: ["tts.readPage", "tts.readFromHere"],
      },
    ],
  },
  {
    id: "comments",
    icon: MessageSquareText,
    title: "Comments and signatures",
    summary: "Highlights, notes, shapes, stamps and signatures.",
    blocks: [
      {
        title: "Comment tools",
        body: "Press `C` for the comment toolbar. Selecting text shows a floating toolbar to highlight, underline or strike out. Other tools: sticky notes with replies, text boxes, ink, eraser, rectangles, ellipses, arrows, polygons and stamps.",
        commands: ["comment.toolbar"],
      },
      {
        title: "Edit comments",
        body: "With the select tool (`V`) click a comment to move or resize it and change colour, opacity or line width — **comments already in the file can be edited too**. Make the current style the tool's default.",
      },
      {
        title: "Signatures and stamps",
        body: "Draw, type or import a signature and reuse it. Stamps include standard stamps, dynamic stamps with name and date, and picture stamps.",
        commands: ["tool.signature", "tool.image"],
      },
      {
        title: "Comment list",
        body: "The comments pane lists every comment: filter, sort, reply and set a review status; click one to jump to it.",
        commands: ["view.sidebar.annotations"],
      },
    ],
  },
  {
    id: "pages",
    icon: LayoutGrid,
    title: "Organizing pages",
    summary: "Insert, merge, rotate, flip, delete and split pages.",
    blocks: [
      {
        title: "Page organizer",
        body: "`Ctrl+Shift+O` opens the organizer: click to select, `Ctrl` / `Shift` + click for several, drag to reorder. Hover a page to rotate or delete it; the \"+\" between pages inserts there. Keys: `R` rotate, `Ctrl+D` duplicate, `Delete`, `Esc` to close.",
        commands: ["page.organize"],
      },
      {
        title: "Combine PDFs and pictures",
        body: "*Insert Pages from Files* takes several PDFs and pictures (JPG, PNG, WebP, GIF, BMP) at once; reorder them and pick page ranges per PDF. Pictures keep their own size or fit A4, Letter or the current page. In the organizer you can also drop files from Explorer between two pages.",
        commands: ["page.insertFile", "page.insertBlank"],
      },
      {
        title: "Rotate, flip, duplicate, replace",
        body: "Rotate selected or all pages, mirror pages horizontally or vertically (comments move along), duplicate pages, or replace pages by other files.",
        commands: ["page.rotateAllCw", "page.flipH", "page.duplicate", "page.replace"],
      },
      {
        title: "Extract and split",
        body: "Save pages as a new file, or split the document every N pages, into N files or by custom ranges.",
        commands: ["page.extract", "page.split"],
      },
      {
        title: "Undo",
        body: "Every page operation can be undone with `Ctrl+Z` until you save.",
        commands: ["edit.undo"],
      },
    ],
  },
  {
    id: "ocr",
    icon: FileScan,
    title: "Snapshots and OCR",
    summary: "Region snapshots, recognizing text, searchable scans.",
    blocks: [
      {
        title: "Region snapshots",
        body: "`Ctrl+Alt+S`, then drag over an area: the picture is copied to the clipboard and can be saved as PNG. It is re-rendered from the PDF; choose 150–600 DPI in Settings.",
        commands: ["tool.snapshot"],
      },
      {
        title: "Recognize text in a region",
        body: "`Ctrl+Alt+T`, then drag over any area — scans and pictures included. The recognized text opens in a dialog to edit and copy.",
        commands: ["tool.ocrRegion"],
      },
      {
        title: "Make scans searchable",
        body: "*Recognize Text (OCR)* adds an invisible text layer so scanned pages can be searched, selected and copied while looking the same. Pages that already contain text are skipped by default; cancel any time and undo until you save. Scanned documents are detected when opened.",
        commands: ["doc.ocr"],
      },
      {
        title: "What OCR can read",
        body: "Printed Chinese and English, entirely on this computer — nothing is uploaded. Handwriting, decorative fonts and very small text may be inaccurate; choose 300 dpi for small print.",
      },
    ],
  },
  {
    id: "protect",
    icon: Lock,
    title: "Watermarks and passwords",
    summary: "Text or picture watermarks; add or remove passwords.",
    blocks: [
      {
        title: "Watermarks",
        body: "Add text (CJK and several lines supported) or picture watermarks with opacity, angle, position or tiling, above or behind the content, with a live preview. Watermarks become part of the page; undo until you save.",
        commands: ["doc.watermark"],
      },
      {
        title: "Protect with a password",
        body: "*Password Protection* uses AES-256:\n- **Open password**: nobody can read the document without it\n- **Permissions password**: forbid printing, copying, commenting or editing\nKeep your passwords safe — they cannot be recovered. Protection is written when you save.",
        commands: ["doc.security"],
      },
      {
        title: "Remove a password",
        body: "Open the document, choose *Remove Password Protection* and save. Restricted documents need their permissions password; entering it also lifts the restrictions for the session.",
        commands: ["doc.removeSecurity"],
      },
    ],
  },
  {
    id: "saving",
    icon: Save,
    title: "Saving and safety",
    summary: "How files are saved, backups, crash recovery, properties.",
    blocks: [
      {
        title: "Saving",
        body: "`Ctrl+S` saves, `Ctrl+Shift+S` saves as. Changes are appended as an incremental update, so the original content stays intact and **digital signatures remain valid**. Files are written to a temporary file and swapped in; Settings can keep a `.bak` copy.",
        commands: ["file.save", "file.saveAs"],
      },
      {
        title: "Crash recovery",
        body: "Unsaved comments are saved regularly in the background and can be restored after a crash when the document is opened again.",
      },
      {
        title: "Changes by other programs",
        body: "You are told when an open file is changed or deleted by another program, and can reload or keep the current state.",
        commands: ["file.reload"],
      },
      {
        title: "Document properties",
        body: "`Ctrl+D` shows and edits title, author, subject and keywords, plus security settings and fonts.",
        commands: ["file.properties"],
      },
    ],
  },
  { id: "shortcuts", icon: Keyboard, title: "Keyboard shortcuts", summary: "Every shortcut currently in effect; change them in Settings.", blocks: [], special: "shortcuts" },
  {
    id: "faq",
    icon: CircleHelp,
    title: "FAQ",
    summary: "Installation, portable use, data location, troubleshooting.",
    blocks: [
      {
        title: "SmartScreen warning when installing",
        body: "The installers are not code-signed yet. Choose \"More info\" → \"Run anyway\"; the release page lists SHA-256 checksums of every file.",
      },
      {
        title: "Portable use and where data is stored",
        body: "The portable version keeps settings, recent files and logs in a `data` folder next to the program. Installed versions use the user's application data folder — open it from *About and updates*.",
      },
      {
        title: "Forgotten PDF password",
        body: "Encryption uses AES-256: without the open password the document cannot be opened, and this app cannot crack it.",
      },
      {
        title: "Blank window on Linux",
        body: "Some graphics drivers and virtual machines need `WEBKIT_DISABLE_DMABUF_RENDERER=1` in the environment for WebKitGTK to draw.",
      },
      {
        title: "Report a problem",
        body: "Issues and ideas are welcome on GitHub. Attaching the log file (*Help ▸ Open Log Folder*) helps a lot.",
        commands: ["help.logs"],
      },
    ],
  },
  { id: "about", icon: Info, title: "About and updates", summary: "Version, update check and licences.", blocks: [], special: "about" },
];

/** The guide for an interface language (Chinese for zh-*, English otherwise). */
export function helpTopics(locale: string): HelpTopic[] {
  const lang: Lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
  return lang === "zh" ? ZH : EN;
}

/** Every command referenced by the guide (checked by the tests). */
export function referencedCommands(): string[] {
  return [...new Set([...ZH, ...EN].flatMap((t) => t.blocks.flatMap((b) => b.commands ?? [])))];
}

/** Topics and blocks matching `query` (case-insensitive, all words must match). */
export function searchHelp(topics: HelpTopic[], query: string): { topic: HelpTopic; block: HelpBlock }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: { topic: HelpTopic; block: HelpBlock }[] = [];
  for (const topic of topics) {
    for (const block of topic.blocks) {
      const text = `${topic.title} ${block.title} ${block.body}`.toLowerCase();
      if (words.every((w) => text.includes(w))) out.push({ topic, block });
    }
  }
  return out;
}
