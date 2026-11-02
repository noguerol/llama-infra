#!/usr/bin/env python3
"""Generate docs/banner.jpeg and docs/preview.jpeg — the artwork for the public
README and npm/packages listing.

Deterministic, offline, no third-party assets: everything is drawn with Pillow
from system fonts (Bricolage Grotesque for the title, Source Code Pro for the
labels), so the text is crisp and the diagram can never carry stray glyphs or
data from a screenshot. Re-run after changing the copy:

    python3 docs/generate-artwork.py

Design notes: dark terminal-grade background with neon accents (green = the
package, cyan = the extension layer, teal = the agent, yellow = servers,
red = models/resources), mono uppercase labels, arrows for the data path.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent

# Display face: Bricolage Grotesque (variable, set to ExtraBold) when present,
# else any static bold sans. Labels are always mono so the diagram reads like a
# terminal capture.
DISPLAY_CANDIDATES = [
    Path.home() / ".local/share/fonts/BricolageGrotesque-VariableFont_opsz,wdth,wght.ttf",
    Path("/usr/share/fonts/liberation-sans-fonts/LiberationSans-Bold.ttf"),
]
MONO_CANDIDATES = [
    Path("/usr/share/fonts/adobe-source-code-pro-fonts/SourceCodePro-Bold.otf"),
    Path("/usr/share/fonts/liberation-mono-fonts/LiberationMono-Bold.ttf"),
]


def _pick(candidates: list[Path]) -> Path:
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise SystemExit(f"no usable font found in {candidates}")


DISPLAY_FONT = _pick(DISPLAY_CANDIDATES)
MONO_FONT = _pick(MONO_CANDIDATES)

GREEN = (109, 242, 163)
CYAN = (88, 200, 255)
TEAL = (79, 211, 224)
YELLOW = (245, 215, 110)
RED = (255, 93, 120)
BLUE = (120, 170, 255)

BG_TOP = (7, 11, 18)
BG_BOTTOM = (13, 21, 32)


def lerp(a, b, t):
    return int(round(a + (b - a) * t))


def background(width, height):
    """Vertical gradient + grid + scanlines + vignette."""
    img = Image.new("RGB", (width, height))
    draw = ImageDraw.Draw(img)
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line([(0, y), (width, y)], fill=(lerp(BG_TOP[0], BG_BOTTOM[0], t), lerp(BG_TOP[1], BG_BOTTOM[1], t), lerp(BG_TOP[2], BG_BOTTOM[2], t)))

    grid = Image.new("RGB", (width, height), (0, 0, 0))
    gdraw = ImageDraw.Draw(grid)
    step = max(28, width // 46)
    for x in range(0, width, step):
        gdraw.line([(x, 0), (x, height)], fill=(0, 26, 22))
    for y in range(0, height, step):
        gdraw.line([(0, y), (width, y)], fill=(0, 26, 22))
    img = ImageChops.add(img, grid)

    scan = Image.new("RGB", (width, height), (0, 0, 0))
    sdraw = ImageDraw.Draw(scan)
    for y in range(0, height, 3):
        sdraw.line([(0, y), (width, y)], fill=(0, 5, 4))
    img = ImageChops.subtract(img, scan)

    vignette = Image.new("L", (width, height), 0)
    vdraw = ImageDraw.Draw(vignette)
    vdraw.ellipse(
        [-width * 0.15, -height * 0.30, width * 1.15, height * 1.30],
        fill=255,
    )
    vignette = vignette.filter(ImageFilter.GaussianBlur(width // 12))
    dark = Image.new("RGB", (width, height), (0, 0, 0))
    return Image.composite(img, dark, vignette)


def font(path, size, variation=None):
    fnt = ImageFont.truetype(path, size)
    if variation:
        try:
            fnt.set_variation_by_name(variation)
        except (OSError, ValueError, AttributeError):
            pass  # static font: it is already the weight we want
    return fnt


def display(size, variation="ExtraBold"):
    return font(DISPLAY_FONT, size, variation)


def tracked_text(draw, xy, text, fnt, fill, tracking=0.0):
    """Draw text with per-character tracking (Pillow has no letter-spacing)."""
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += draw.textlength(ch, font=fnt) + tracking
    return x


def tracked_width(draw, text, fnt, tracking=0.0):
    total = 0.0
    for ch in text:
        total += draw.textlength(ch, font=fnt) + tracking
    return total - tracking if text else 0.0


class Scene:
    """Layered canvas: everything neon is drawn twice (blurred + crisp)."""

    def __init__(self, width, height):
        self.w, self.h = width, height
        self.base = background(width, height)
        self.glow = Image.new("RGB", (width, height), (0, 0, 0))
        self.gd = ImageDraw.Draw(self.glow)
        self.crisp = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        self.cd = ImageDraw.Draw(self.crisp)

    # ── primitives ────────────────────────────────────────────────────────
    def panel(self, box, color, radius=None):
        x0, y0, x1, y1 = box
        r = radius if radius is not None else max(6, (x1 - x0) // 40)
        self.gd.rounded_rectangle(box, radius=r, outline=color, width=3)
        self.cd.rounded_rectangle(box, radius=r, outline=color + (255,), width=max(1, (x1 - x0) // 260))
        for inset, alpha in ((6, 0.16), (12, 0.08)):
            inner = (x0 + inset, y0 + inset, x1 - inset, y1 - inset)
            self.cd.rounded_rectangle(inner, radius=max(4, r - inset // 2), outline=color + (int(255 * alpha),), width=1)

    def label(self, xy, text, size, color, tracking=0.10, anchor_left=True, weight="mono"):
        fnt = display(size) if weight == "display" else font(MONO_FONT, size)
        track = size * tracking
        width = tracked_width(self.cd, text, fnt, track)
        x, y = xy
        if not anchor_left:
            x -= width / 2
        tracked_text(self.gd, (x, y), text, fnt, color)
        tracked_text(self.cd, (x, y), text, fnt, color + (255,))
        return width

    def body(self, xy, text, size, color, alpha=235):
        fnt = font(MONO_FONT, size)
        self.gd.text(xy, text, font=fnt, fill=color)
        self.cd.text(xy, text, font=fnt, fill=color + (alpha,))

    def tag(self, xy, text, color, size=None):
        """Small boxed caption, e.g. `thinking level: configured`."""
        size = size or max(11, int(self.w * 0.0115))
        fnt = font(MONO_FONT, size)
        pad = size * 0.65
        x, y = xy
        width = self.cd.textlength(text, font=fnt)
        box = (x, y, x + width + pad * 2, y + size * 1.9)
        self.cd.rectangle(box, fill=(6, 14, 20, 210), outline=color + (255,), width=2)
        self.gd.rectangle(box, outline=color, width=2)
        self.gd.text((x + pad, y + size * 0.38), text, font=fnt, fill=color)
        self.cd.text((x + pad, y + size * 0.38), text, font=fnt, fill=color + (255,))
        return box

    def arrow(self, start, end, color, curve=0.0, width=None):
        width = width or max(2, self.w // 700)
        (x0, y0), (x1, y1) = start, end
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        nx, ny = -(y1 - y0), (x1 - x0)
        norm = math.hypot(nx, ny) or 1.0
        cx, cy = mx + nx / norm * curve, my + ny / norm * curve
        steps = 40
        pts = []
        for i in range(steps + 1):
            t = i / steps
            px = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1
            py = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1
            pts.append((px, py))
        self.gd.line(pts, fill=color, width=width * 3, joint="curve")
        self.cd.line(pts, fill=color + (255,), width=width, joint="curve")
        # arrow head
        ax, ay = pts[-2]
        angle = math.atan2(y1 - ay, x1 - ax)
        head = max(8, self.w // 90)
        for side in (+1, -1):
            hx = x1 - head * math.cos(angle + side * 0.5)
            hy = y1 - head * math.sin(angle + side * 0.5)
            self.gd.line([(x1, y1), (hx, hy)], fill=color, width=width * 3)
            self.cd.line([(x1, y1), (hx, hy)], fill=color + (255,), width=width)

    def server_icon(self, x, y, w, h, color):
        for i in range(3):
            top = y + i * (h * 0.30)
            box = (x, top, x + w, top + h * 0.26)
            self.cd.rounded_rectangle(box, radius=w * 0.06, fill=(10, 16, 14, 220), outline=color + (255,), width=2)
            self.gd.rounded_rectangle(box, radius=w * 0.06, outline=color, width=2)
            led = (box[0] + w * 0.10, top + h * 0.09)
            self.cd.ellipse([led[0], led[1], led[0] + w * 0.05, led[1] + w * 0.05], fill=color + (255,))
            self.cd.line([(box[0] + w * 0.24, led[1] + w * 0.02), (box[2] - w * 0.10, led[1] + w * 0.02)], fill=color + (170,), width=2)

    def gguf_icon(self, x, y, w, h, color, name, size):
        fold = w * 0.26
        page = [(x, y), (x + w - fold, y), (x + w, y + fold), (x + w, y + h), (x, y + h)]
        self.cd.polygon(page, fill=(16, 10, 14, 225), outline=color + (255,))
        self.gd.polygon(page, outline=color)
        self.cd.polygon([(x + w - fold, y), (x + w - fold, y + fold), (x + w, y + fold)], fill=color + (70,))
        # name centred in the page body, clear of the fold
        fnt = font(MONO_FONT, size)
        tw = self.cd.textlength(name, font=fnt)
        self.gd.text((x + (w - tw) / 2, y + h * 0.52), name, font=fnt, fill=color)
        self.cd.text((x + (w - tw) / 2, y + h * 0.52), name, font=fnt, fill=color + (245,))
        # two stub lines so it reads as a file, not an empty box
        for i, width_ratio in enumerate((0.62, 0.44)):
            line_y = y + h * 0.74 + i * size * 1.5
            self.cd.line([(x + w * 0.16, line_y), (x + w * 0.16 + w * width_ratio, line_y)], fill=color + (120,), width=2)

    def compose(self, glow_radius):
        blurred = self.glow.filter(ImageFilter.GaussianBlur(glow_radius))
        glow2 = self.glow.filter(ImageFilter.GaussianBlur(glow_radius * 2.6))
        out = ImageChops.add(self.base, blurred)
        out = ImageChops.add(out, glow2.point(lambda v: int(v * 0.55)))
        out = out.convert("RGBA")
        out.alpha_composite(self.crisp)
        return out.convert("RGB")


def render(width, height):
    s = width / 1600.0  # scale everything from the 1600px reference layout
    sc = Scene(width, height)

    def P(x):
        return int(round(x * s))

    # ── Header ────────────────────────────────────────────────────────────
    title = display(P(142))
    tx, ty = P(80), P(26)
    sc.gd.text((tx + P(3), ty + P(3)), "llama-infra", font=title, fill=(40, 200, 120))
    sc.cd.text((tx, ty), "llama-infra", font=title, fill=GREEN + (255,))

    sub = display(P(54), variation="SemiBold")
    sc.gd.text((tx + P(2), ty + P(160)), "Package for Pi agent", font=sub, fill=(30, 150, 110))
    sc.cd.text((tx, ty + P(158)), "Package for Pi agent", font=sub, fill=(214, 246, 232, 255))

    sc.label((tx + P(3), ty + P(232)), "LLM INFERENCE & AGENT INTEGRATION FRAMEWORK", P(16), (140, 200, 190), tracking=0.22)
    sc.label((tx - P(40), ty + P(2)), ">", P(44), GREEN, tracking=0.0)

    # ── Badges ────────────────────────────────────────────────────────────
    sc.tag((P(96), P(292)), "thinking level: configured", BLUE)
    sc.tag((P(560), P(596)), "MULTIPLE SERVER SETUP", YELLOW)
    sc.tag((P(1292), P(292)), "inference status: active", BLUE)

    # ── PI EXTENSION LAYER (cyan) ─────────────────────────────────────────
    ext = (P(150), P(340), P(690), P(580))
    sc.panel(ext, CYAN)
    sc.label((ext[0] + P(22), ext[1] + P(18)), "PI EXTENSION LAYER", P(24), CYAN)
    for i, item in enumerate(("MODEL BROWSING", "LIVE SWITCHING", "LOAD PROGRESS", "THINKING BUDGETS")):
        col = ext[0] + P(28) + (i % 2) * P(262)
        row = ext[1] + P(76) + (i // 2) * P(52)
        sc.cd.rectangle((col, row, col + P(13), row + P(13)), outline=CYAN + (255,), width=2)
        sc.gd.rectangle((col, row, col + P(13), row + P(13)), outline=CYAN, width=2)
        sc.body((col + P(24), row - P(5)), item, P(16), CYAN)
    sc.body((ext[0] + P(22), ext[3] - P(38)), "extension registers the llama-infra provider", P(14), (150, 205, 225), alpha=225)

    # ── PI AGENT (teal cube) ──────────────────────────────────────────────
    cx, cy = P(795), P(392)
    cube_w, cube_h = P(160), P(104)
    top = [(cx, cy), (cx + cube_w // 2, cy - cube_h // 3), (cx + cube_w, cy), (cx + cube_w // 2, cy + cube_h // 3)]
    left = [(cx, cy), (cx, cy + cube_h), (cx + cube_w // 2, cy + cube_h + cube_h // 3), (cx + cube_w // 2, cy + cube_h // 3)]
    right = [(cx + cube_w, cy), (cx + cube_w, cy + cube_h), (cx + cube_w // 2, cy + cube_h + cube_h // 3), (cx + cube_w // 2, cy + cube_h // 3)]
    for poly, shade in ((right, (10, 46, 44, 230)), (left, (14, 60, 56, 235)), (top, (22, 92, 84, 240))):
        sc.cd.polygon(poly, fill=shade, outline=TEAL + (255,))
        sc.gd.polygon(poly, outline=TEAL)
    agent_cx = cx + cube_w // 2
    agent_bottom = cy + cube_h + cube_h // 3
    sc.label((agent_cx, agent_bottom + P(14)), "PI AGENT", P(22), TEAL, tracking=0.16, anchor_left=False)

    # ── RESOURCE MANAGEMENT (red) ─────────────────────────────────────────
    res = (P(1130), P(340), P(1520), P(580))
    sc.panel(res, RED)
    sc.label((res[0] + P(22), res[1] + P(18)), "RESOURCE MANAGEMENT", P(24), RED)
    for i, item in enumerate(("RAM MONITOR", "BENCHMARKING", "THREAD CONTROL")):
        row = res[1] + P(74) + i * P(38)
        sc.body((res[0] + P(26), row), item, P(16), (255, 170, 180))
        sc.cd.line([(res[0] + P(26), row + P(22)), (res[0] + P(180), row + P(22))], fill=RED + (110,), width=2)
    sc.body((res[0] + P(22), res[3] - P(38)), "local RAM limits · on-device AI · CMake", P(14), (235, 150, 160))

    # ── LLAMA.CPP SERVERS & MODELS (yellow) ───────────────────────────────
    srv = (P(300), P(624), P(770), P(856))
    sc.panel(srv, YELLOW)
    sc.label((srv[0] + P(22), srv[1] + P(16)), "LLAMA.CPP SERVERS & MODELS", P(22), YELLOW)
    for i in range(3):
        tower_x = srv[0] + P(32) + i * P(74)
        tower_y = srv[1] + P(64)
        sc.cd.rounded_rectangle(
            (tower_x, tower_y, tower_x + P(58), tower_y + P(112)),
            radius=P(5), fill=(12, 16, 10, 225), outline=YELLOW + (255,), width=2,
        )
        sc.gd.rounded_rectangle((tower_x, tower_y, tower_x + P(58), tower_y + P(112)), radius=P(5), outline=YELLOW, width=2)
        for slot in range(3):
            slot_y = tower_y + P(12) + slot * P(34)
            sc.cd.rounded_rectangle((tower_x + P(8), slot_y, tower_x + P(50), slot_y + P(22)), radius=P(3), outline=YELLOW + (170,), width=1)
            led = (tower_x + P(12), slot_y + P(8))
            sc.cd.ellipse([led[0], led[1], led[0] + P(5), led[1] + P(5)], fill=YELLOW + (230,))
    sc.body((srv[0] + P(266), srv[1] + P(66)), "llama-server · -api-key", P(14), (240, 220, 150))
    sc.body((srv[0] + P(266), srv[1] + P(90)), "-sleep-idle-seconds", P(14), (240, 220, 150))
    sc.body((srv[0] + P(22), srv[3] - P(38)), "any OpenAI-compatible engine · HF gated repos", P(13), (235, 220, 160))

    # ── GGUF MODELS (red) ─────────────────────────────────────────────────
    gg = (P(900), P(624), P(1330), P(856))
    sc.panel(gg, RED)
    sc.label((gg[0] + P(22), gg[1] + P(16)), "GGUF MODELS", P(22), RED)
    for i, name in enumerate(("model-a.gguf", "model-b.gguf", "model-c.gguf")):
        sc.gguf_icon(gg[0] + P(34) + i * P(132), gg[1] + P(58), P(114), P(98), RED, name, P(12))
    sc.body((gg[0] + P(22), gg[3] - P(60)), "GGUF format support · quantized weights", P(13), (235, 150, 160))
    sc.body((gg[0] + P(22), gg[3] - P(36)), "vision detection · draft models", P(13), (235, 150, 160))

    # ── Arrows (one per relationship, labelled away from the line) ────────
    sc.arrow((P(690), P(440)), (P(800), P(440)), CYAN, curve=-10 * s)
    sc.body((P(700), P(404)), "RPC", P(13), (150, 205, 225))
    sc.arrow((P(955), P(440)), (P(1124), P(440)), RED, curve=8 * s)
    sc.arrow((P(876), P(566)), (P(876), P(618)), TEAL, curve=8 * s)
    sc.body((P(892), P(576)), "SSE/Polling", P(13), (150, 205, 225))
    sc.arrow((P(770), P(742)), (P(896), P(742)), YELLOW, curve=-8 * s)
    sc.body((P(776), P(704)), "unload others?", P(12), (185, 195, 210))

    return sc.compose(glow_radius=max(3, int(width / 260)))


def main():
    # Both assets share the reference aspect ratio: the layout is drawn in a
    # 1600x893 coordinate system and scaled by width, so a different aspect
    # would leave empty bands instead of a framing.
    banner = render(1600, 893)
    banner.save(HERE / "banner.jpeg", quality=92, subsampling=1)
    preview = render(1200, 670)
    preview.save(HERE / "preview.jpeg", quality=92, subsampling=1)
    print("wrote", HERE / "banner.jpeg", banner.size)
    print("wrote", HERE / "preview.jpeg", preview.size)


if __name__ == "__main__":
    main()
