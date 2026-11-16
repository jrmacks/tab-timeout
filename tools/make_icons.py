#!/usr/bin/env python3
"""Generate the extension's PNG icons with no third-party deps.

Draws a simple clock dial on a rounded indigo tile. Renders at 4x and
box-downsamples for anti-aliasing, then writes a minimal RGBA PNG by hand
(zlib + the handful of chunks Chrome actually needs).
"""

import math
import os
import struct
import zlib

SS = 4  # supersampling factor
SIZES = (16, 48, 128)

BG = (79, 70, 229)      # indigo tile
FG = (255, 255, 255)    # clock strokes
TRANSPARENT = (0, 0, 0, 0)


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def dist_point_segment(px, py, ax, ay, bx, by):
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return math.hypot(px - ax, py - ay)
    t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy), 0.0, 1.0)
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def in_rounded_rect(x, y, w, h, r):
    cx = clamp(x, r, w - r)
    cy = clamp(y, r, h - r)
    return math.hypot(x - cx, y - cy) <= r


def sample(x, y, n):
    """Return RGBA for a supersampled pixel center at (x, y) on an n x n canvas."""
    pad = n * 0.06
    if not in_rounded_rect(x, y, n, n, n * 0.22) or x < pad or y < pad or x > n - pad or y > n - pad:
        # outside tile (slim transparent margin so the tile isn't clipped)
        if not in_rounded_rect(x, y, n, n, n * 0.22):
            return TRANSPARENT
    cx = cy = n / 2.0
    radius = n * 0.34
    ring = n * 0.055
    d = math.hypot(x - cx, y - cy)

    # clock ring
    if abs(d - radius) <= ring:
        return (*FG, 255)
    # center hub
    if d <= n * 0.045:
        return (*FG, 255)
    # hour hand (points up) and minute hand (points right-ish)
    hand_w = n * 0.045
    if dist_point_segment(x, y, cx, cy, cx, cy - radius * 0.55) <= hand_w:
        return (*FG, 255)
    if dist_point_segment(x, y, cx, cy, cx + radius * 0.68, cy + radius * 0.05) <= hand_w:
        return (*FG, 255)
    # tile background
    return (*BG, 255)


def render(size):
    n = size * SS
    # supersampled buffer
    buf = [sample(x + 0.5, y + 0.5, n) for y in range(n) for x in range(n)]
    out = bytearray()
    for y in range(size):
        out.append(0)  # PNG filter type 0 (none) per scanline
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                for sx in range(SS):
                    px = (y * SS + sy) * n + (x * SS + sx)
                    pr, pg, pb, pa = buf[px]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            count = SS * SS
            if a == 0:
                out += bytes((0, 0, 0, 0))
            else:
                out += bytes((round(r / a), round(g / a), round(b / a), round(a / count)))
    return bytes(out)


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, size, raw):
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) +
           chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in SIZES:
        write_png(os.path.join(out_dir, f"icon{size}.png"), size, render(size))
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
