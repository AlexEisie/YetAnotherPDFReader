"""
Build every app icon from one square-ish PNG with a transparent background.

    python scripts/make-icons.py path/to/icon.png

- removes the faint haze that background removal leaves around the artwork,
- trims and centres it on a square canvas with a small margin,
- writes the master src-tauri/icons/app-icon.png (1024 px),
- runs `tauri icon` for the Windows / macOS / Linux icons (mobile icons are dropped),
- writes the in-app logo (src/assets/logo.png) and the favicon (public/favicon.png).

Then regenerate the README pictures that show the icon (node scripts/readme-shots.mjs) and
force a rebuild of the app crate (cargo clean -p yapr, also with --release): Cargo does not
notice changed icon files, so the executable would keep the old icon.
"""
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"
HAZE = 12  # alpha below this is treated as background
MARGIN = 0.03


def master(src: Path) -> Image.Image:
    a = np.array(Image.open(src).convert("RGBA")).astype(np.float32)
    alpha = a[..., 3]
    alpha = np.clip((np.where(alpha < HAZE, 0, alpha) - HAZE) * 255 / (255 - HAZE), 0, 255)
    a[..., 3] = alpha
    a[alpha == 0, :3] = 0
    ys, xs = np.nonzero(alpha > 0)
    art = Image.fromarray(a.astype(np.uint8)).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    side = max(art.size)
    full = side + 2 * round(side * MARGIN)
    canvas = Image.new("RGBA", (full, full), (0, 0, 0, 0))
    canvas.paste(art, ((full - art.width) // 2, (full - art.height) // 2))
    out = np.array(canvas.resize((1024, 1024), Image.LANCZOS))  # Pillow premultiplies RGBA
    out[out[..., 3] == 0, :3] = 0
    return Image.fromarray(out)


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    icon = master(Path(sys.argv[1]))
    icon.save(ICONS / "app-icon.png", optimize=True)
    npx = "npx.cmd" if sys.platform == "win32" else "npx"
    subprocess.run([npx, "tauri", "icon", str(ICONS / "app-icon.png"), "-o", str(ICONS)], cwd=ROOT, check=True)
    for mobile in ("android", "ios"):
        shutil.rmtree(ICONS / mobile, ignore_errors=True)
    (ROOT / "src" / "assets").mkdir(exist_ok=True)
    icon.resize((256, 256), Image.LANCZOS).save(ROOT / "src" / "assets" / "logo.png", optimize=True)
    icon.resize((64, 64), Image.LANCZOS).save(ROOT / "public" / "favicon.png", optimize=True)
    print("icons written; now run: node scripts/readme-shots.mjs, then cargo clean -p yapr [--release] before building")


if __name__ == "__main__":
    main()
