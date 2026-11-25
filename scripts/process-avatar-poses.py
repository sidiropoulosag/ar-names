#!/usr/bin/env python3
"""Convert Noera avatar JPEGs into web-ready webp + fallback assets.

Default:
  /workspace/noera-avatar-poses/*.jpg  →  <repo>/tutorial/<name>.webp + .png

Special files (same folder, same filenames if regenerated):
  profile-avatar.jpg  →  icons/profile-avatar.webp + .png
      (circular crop, transparent corners, 320px)
  preview-avatar.jpg  →  tutorial/preview-avatar.webp + .jpg
      (cafe background kept, no cut-out, compressed <80KB)

Everything else gets a transparent background (white/near-white flood from
the border, plus leftover enclosed white gaps). White props that contain
interior artwork (emergency card, phone screen, lock, logo “N”) are kept.

Re-run after Giorgis drops new JPEGs under the SAME filenames:
  python3 scripts/process-avatar-poses.py
  python3 scripts/process-avatar-poses.py --src /path/to/jpgs --out /path/to/repo

Needs: Pillow, and pngquant on PATH (PNG fallbacks are quantized).
"""
from __future__ import annotations

import argparse
import collections
import math
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image

MAX_SIDE = 600
WEBP_Q = 82
WEBP_BUDGET = 80_000
PROFILE_SIZE = 320
PREVIEW_MAX_SIDE = 960

# files that are not cut-out tutorial poses
KEEP_BG = {"preview-avatar"}
CIRCLE_CROP = {"profile-avatar"}
# extra poses (e.g. var-phone, var-think) are still converted into tutorial/


def is_bg_color(r, g, b, loose=False):
    mn, mx = min(r, g, b), max(r, g, b)
    if mx - mn > (16 if loose else 12):
        return False
    return mn >= (225 if loose else 242)


def flood_bg(im):
    w, h = im.size
    px = im.load()
    bg = [[False] * w for _ in range(h)]
    q = collections.deque()

    def try_push(x, y, loose):
        if not (0 <= x < w and 0 <= y < h) or bg[y][x]:
            return
        r, g, b = px[x, y][:3]
        if is_bg_color(r, g, b, loose=loose):
            bg[y][x] = True
            q.append((x, y))

    for x in range(w):
        try_push(x, 0, False)
        try_push(x, h - 1, False)
    for y in range(h):
        try_push(0, y, False)
        try_push(w - 1, y, False)
    while q:
        x, y = q.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx or dy:
                    try_push(x + dx, y + dy, True)
    return bg


def component_has_holes(comp, w, h, px):
    """True if the white blob encloses non-white artwork (card cross, letter, lock)."""
    xs = [p[0] for p in comp]
    ys = [p[1] for p in comp]
    minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)
    inset = set(comp)
    bw, bh = maxx - minx + 3, maxy - miny + 3
    # map to local coords with 1px pad
    ox, oy = minx - 1, miny - 1
    seen = [[False] * bw for _ in range(bh)]
    q = collections.deque()

    def edge(lx, ly):
        if 0 <= lx < bw and 0 <= ly < bh and not seen[ly][lx]:
            gx, gy = lx + ox, ly + oy
            if (gx, gy) not in inset:
                seen[ly][lx] = True
                q.append((lx, ly))

    for lx in range(bw):
        edge(lx, 0)
        edge(lx, bh - 1)
    for ly in range(bh):
        edge(0, ly)
        edge(bw - 1, ly)
    while q:
        lx, ly = q.popleft()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if not (dx or dy):
                    continue
                nx, ny = lx + dx, ly + dy
                if not (0 <= nx < bw and 0 <= ny < bh) or seen[ny][nx]:
                    continue
                gx, gy = nx + ox, ny + oy
                if (gx, gy) in inset:
                    continue
                seen[ny][nx] = True
                q.append((nx, ny))
    holes = 0
    for ly in range(bh):
        for lx in range(bw):
            if seen[ly][lx]:
                continue
            gx, gy = lx + ox, ly + oy
            if (gx, gy) in inset:
                continue
            holes += 1
            if holes >= 24:
                return True
    return False


def fill_leftover_gaps(im, bg):
    """Fill enclosed almost-white arm/torso gaps; keep logo whites and props with holes."""
    w, h = im.size
    px = im.load()
    vis = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            if bg[y][x] or vis[y][x]:
                continue
            r, g, b = px[x, y][:3]
            if not is_bg_color(r, g, b, loose=True):
                continue
            comp, qq = [], collections.deque([(x, y)])
            vis[y][x] = True
            has_blue = False
            dark_n = 0
            skin = 0
            minx = maxx = x
            miny = maxy = y
            while qq:
                cx, cy = qq.popleft()
                comp.append((cx, cy))
                if cx < minx: minx = cx
                if cx > maxx: maxx = cx
                if cy < miny: miny = cy
                if cy > maxy: maxy = cy
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if not (dx or dy):
                            continue
                        nx, ny = cx + dx, cy + dy
                        if not (0 <= nx < w and 0 <= ny < h) or vis[ny][nx]:
                            continue
                        nr, ng, nb = px[nx, ny][:3]
                        if nb > 140 and nb - nr > 40 and nb - ng > 20:
                            has_blue = True
                        if min(nr, ng, nb) < 50:
                            dark_n += 1
                        if nr > 140 and ng > 80 and nb < 160 and nr > nb + 20 and nr > ng:
                            skin += 1
                        if is_bg_color(nr, ng, nb, loose=True):
                            vis[ny][nx] = True
                            qq.append((nx, ny))
            area = len(comp)
            if area < 250:
                continue
            bw, bh = maxx - minx + 1, maxy - miny + 1
            fill = area / (bw * bh)
            # small white marks on the blue logo (the “N”) — keep
            if has_blue and area < 3000:
                continue
            # white logo drawn directly on a black shirt (no blue badge) — keep
            if skin == 0 and dark_n > 40 and area < 8000:
                continue
            # sparse slivers (ticket / map speckles) — keep
            if fill < 0.30:
                continue
            # white card / phone screen / lock: they enclose artwork
            if component_has_holes(comp, w, h, px):
                continue
            for cx, cy in comp:
                bg[cy][cx] = True
    return bg


def apply_mask(im, bg):
    im = im.convert("RGBA")
    w, h = im.size
    out = im.copy()
    px = out.load()
    for y in range(h):
        for x in range(w):
            if bg[y][x]:
                r, g, b, _ = px[x, y]
                px[x, y] = (r, g, b, 0)
    src = [row[:] for row in bg]
    for y in range(h):
        for x in range(w):
            if src[y][x]:
                continue
            nbg = 0
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < w and 0 <= ny < h and src[ny][nx]:
                        nbg += 1
            if nbg == 0:
                continue
            r, g, b, a = px[x, y]
            wh = (r + g + b) / 3 / 255
            fade = int(a * (1 - (nbg / 8) * 0.7 * min(1, max(0, (wh - 0.55) / 0.45))))
            if nbg >= 4 and wh > 0.9:
                fade = 0
            px[x, y] = (r, g, b, max(0, min(a, fade)))
    return out


def tight_crop(im, pad=18):
    bbox = im.getbbox()
    if not bbox:
        return im
    x0, y0, x1, y1 = bbox
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(im.width, x1 + pad), min(im.height, y1 + pad)
    return im.crop((x0, y0, x1, y1))


def fit(im, max_side):
    w, h = im.size
    s = max_side / max(w, h)
    if s >= 0.999:
        return im
    return im.resize((int(round(w * s)), int(round(h * s))), Image.Resampling.LANCZOS)


def pngquant(path: Path):
    exe = shutil.which("pngquant")
    if not exe:
        return
    r = subprocess.run(
        [exe, "--force", "--quality=70-90", "--speed", "1", "--output", str(path), str(path)],
        capture_output=True,
    )
    if r.returncode not in (0, 99):
        print(f"  pngquant warning for {path.name}: {r.stderr.decode()[:200]}", file=sys.stderr)


def save_webp(im, path: Path, q=WEBP_Q, budget=WEBP_BUDGET):
    im.save(path, "WEBP", quality=q, method=6)
    q2 = q
    while path.stat().st_size > budget and q2 > 62:
        q2 -= 6
        im.save(path, "WEBP", quality=q2, method=6)
    return q2


def process_cutout(rgb: Image.Image) -> Image.Image:
    bg = flood_bg(rgb)
    bg = fill_leftover_gaps(rgb, bg)
    return fit(tight_crop(apply_mask(rgb, bg)), MAX_SIDE)


def process_circle(rgb: Image.Image) -> Image.Image:
    im = rgb.convert("RGBA")
    w, h = im.size
    px = im.load()
    cx, cy = w / 2, h / 2

    def almost_white(r, g, b):
        return min(r, g, b) >= 245 and max(r, g, b) - min(r, g, b) <= 10

    rs = []
    for angle in range(0, 360, 2):
        rad = math.radians(angle)
        last = 0
        for d in range(int(min(cx, cy)), 0, -1):
            x = int(cx + math.cos(rad) * d)
            y = int(cy + math.sin(rad) * d)
            if not (0 <= x < w and 0 <= y < h):
                continue
            r, g, b, a = px[x, y]
            if not almost_white(r, g, b):
                last = d
                break
        if last:
            rs.append(last)
    radius = int(sorted(rs)[len(rs) // 2]) + 2 if rs else int(min(cx, cy) * 0.96)
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    opx = out.load()
    for y in range(h):
        for x in range(w):
            dx, dy = x + 0.5 - cx, y + 0.5 - cy
            d2 = dx * dx + dy * dy
            r, g, b, a = px[x, y]
            if d2 <= (radius - 1.5) ** 2:
                opx[x, y] = (r, g, b, 255)
            elif d2 <= (radius + 1.2) ** 2:
                t = 1 - (math.sqrt(d2) - (radius - 1.5)) / 2.7
                opx[x, y] = (r, g, b, max(0, min(255, int(255 * t))))
    bbox = out.getbbox()
    pad = 8
    x0, y0, x1, y1 = bbox
    out = out.crop((max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)))
    return out.resize((PROFILE_SIZE, PROFILE_SIZE), Image.Resampling.LANCZOS)


def process_preview(rgb: Image.Image) -> Image.Image:
    return fit(rgb.convert("RGB"), PREVIEW_MAX_SIDE)


def dest_for(stem: str, repo: Path):
    if stem in CIRCLE_CROP:
        return repo / "icons"
    return repo / "tutorial"


def main():
    here = Path(__file__).resolve()
    repo = here.parent.parent
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", default="/workspace/noera-avatar-poses", help="folder of source JPEGs")
    ap.add_argument("--out", default=str(repo), help="repo root (writes tutorial/ and icons/)")
    args = ap.parse_args()
    src = Path(args.src)
    repo = Path(args.out)
    if not src.is_dir():
        sys.exit(f"source folder not found: {src}")
    jpgs = sorted(src.glob("*.jpg")) + sorted(src.glob("*.jpeg"))
    if not jpgs:
        sys.exit(f"no JPEGs in {src}")
    (repo / "tutorial").mkdir(parents=True, exist_ok=True)
    (repo / "icons").mkdir(parents=True, exist_ok=True)

    for path in jpgs:
        stem = path.stem
        rgb = Image.open(path).convert("RGB")
        dest = dest_for(stem, repo)
        if stem in KEEP_BG:
            out = process_preview(rgb)
            webp = dest / f"{stem}.webp"
            jpg = dest / f"{stem}.jpg"
            q = save_webp(out, webp)
            out.save(jpg, "JPEG", quality=85, optimize=True)
            print(f"{stem:22} {out.size} webp={webp.stat().st_size:6d} (q~{q}) jpg={jpg.stat().st_size:6d}  -> {dest.name}/")
            continue
        if stem in CIRCLE_CROP:
            out = process_circle(rgb)
        else:
            out = process_cutout(rgb)
        webp = dest / f"{stem}.webp"
        png = dest / f"{stem}.png"
        q = save_webp(out, webp)
        out.save(png, "PNG", optimize=True, compress_level=9)
        pngquant(png)
        print(f"{stem:22} {out.size} webp={webp.stat().st_size:6d} (q~{q}) png={png.stat().st_size:7d}  -> {dest.name}/")


if __name__ == "__main__":
    main()
