#!/usr/bin/env python3
"""Render TeleJibo's artwork in the classic Jibo icon style, with no dependencies.

Classic glyphs are flat white with a little dark-navy detail and a soft long shadow cast
toward the lower right (jibo-ui-classic tokens, iconography.style). Writes:

  icon.png                              330x330 store and main-menu glyph (BEacon tints the tile)
  telejibo/resources/icons/video.png    265x265 action-button icon (camera toggle)
  telejibo/resources/icons/settings.png 265x265 action-button icon (settings)
  telejibo/resources/icons/rotate.png   265x265 action-button icon (video orientation: automatic)
  telejibo/resources/icons/landscape.png, portrait.png  265x265 (video orientation: fixed)
  telejibo/resources/icons/bell.png     265x265 action-button icon (background calls)

PNGs are 8-bit RGBA with only IHDR/IDAT/IEND chunks, and deterministic: the same bytes on
every run. Shapes are 24-unit outlines (Feather-like proportions), supersampled 4x4.
"""
import math
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
SAMPLES = 4
WHITE = (255, 255, 255)
NAVY = (0x1A, 0x25, 0x63)
TILE = ((0x37, 0x65, 0xAB), (0x1A, 0x25, 0x63))  # manifest buttonColor: highlight, shadow


def rounded_rect(x, y, width, height, radius):
    def inside(px, py):
        if not (x <= px <= x + width and y <= py <= y + height):
            return False
        cx = min(max(px, x + radius), x + width - radius)
        cy = min(max(py, y + radius), y + height - radius)
        return (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2
    return inside


def disc(cx, cy, radius):
    return lambda px, py: (px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2


def convex(points):
    def inside(px, py):
        sign = 0
        for (ax, ay), (bx, by) in zip(points, points[1:] + points[:1]):
            cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
            if cross:
                if sign and (cross > 0) != (sign > 0):
                    return False
                sign = cross
        return True
    return inside


def gear(cx, cy, body, tip, hole, teeth, tooth_width):
    def inside(px, py):
        dx, dy = px - cx, py - cy
        r = math.hypot(dx, dy)
        if r <= hole:
            return False
        if r <= body:
            return True
        if r > tip:
            return False
        angle = math.atan2(dy, dx)
        step = 2 * math.pi / teeth
        nearest = round(angle / step) * step
        offset = abs(dx * math.sin(nearest) - dy * math.cos(nearest))  # distance from the tooth's axis
        return offset <= tooth_width / 2
    return inside


# Glyphs: a list of (shape, colour); later shapes paint over earlier ones.
def camera():
    return [(rounded_rect(1.5, 5.5, 15, 13, 2.6), WHITE),
            (convex([(16, 10.4), (22.8, 6.6), (22.8, 17.4), (16, 13.6)]), WHITE),
            # Jibo's eye in the camera body: the navy detail stock glyphs carry.
            (disc(9, 12, 2.9), NAVY)]


def cog():
    return [(gear(12, 12, 7.2, 10.6, 3.3, 8, 3.4), WHITE)]


# Automatic orientation: the portrait screen of the fixed choices, smaller, with two
# arrows turning clockwise around it (the usual auto-rotate sign).
def auto_rotate():
    inner, outer, head, reach = 8.4, 10.3, 2.5, 3.4
    middle = (inner + outer) / 2

    def ring(start, end):
        def inside(px, py):
            dx, dy = px - 12, py - 12
            return inner <= math.hypot(dx, dy) <= outer and start <= math.degrees(math.atan2(dy, dx)) <= end
        return inside

    def point(radius, degrees):
        a = math.radians(degrees)
        return (12 + radius * math.cos(a), 12 + radius * math.sin(a))

    def arrow(start, end):
        tip = point(middle, end + math.degrees(reach / middle))
        cap = point(middle, start)
        return [(ring(start, end), WHITE), (disc(cap[0], cap[1], (outer - inner) / 2), WHITE),
                (convex([point(middle - head, end), point(middle + head, end), tip]), WHITE)]

    screen = [(outline(8.2, 5.4, 7.6, 13.2, 1.8, 1.9), WHITE), (rounded_rect(10.2, 11.1, 3.6, 1.8, 0.9), WHITE)]
    return screen + arrow(-160, -52) + arrow(20, 128)


def outline(x, y, width, height, radius, stroke):
    outer = rounded_rect(x, y, width, height, radius)
    inner = rounded_rect(x + stroke, y + stroke, width - 2 * stroke, height - 2 * stroke, max(0.1, radius - stroke))
    return lambda px, py: outer(px, py) and not inner(px, py)


# A screen in one shape, with the picture's horizon line inside.
def frame(wide):
    if wide:
        return [(outline(2, 5.5, 20, 13, 2.4, 2.2), WHITE), (rounded_rect(7, 11, 10, 2, 1), WHITE)]
    return [(outline(5.5, 2, 13, 20, 2.4, 2.2), WHITE), (rounded_rect(9, 11, 6, 2, 1), WHITE)]


def bell():
    return [(disc(12, 9.6, 5.6), WHITE),
            (convex([(6.4, 9.6), (17.6, 9.6), (19.6, 17.2), (4.4, 17.2)]), WHITE),
            (rounded_rect(3.2, 16.2, 17.6, 2.4, 1.2), WHITE),
            (disc(12, 20.4, 1.9), WHITE)]


def raster(width, height, glyph, scale, origin):
    """Coverage and colour per pixel for glyph drawn at `scale` px/unit, unit (0,0) at `origin`."""
    alpha = [[0.0] * width for _ in range(height)]
    colour = [[WHITE] * width for _ in range(height)]
    ox, oy = origin
    span = 24 * scale
    x0, x1 = max(0, int(ox) - 2), min(width, int(ox + span) + 3)
    y0, y1 = max(0, int(oy) - 2), min(height, int(oy + span) + 3)
    offsets = [(i + 0.5) / SAMPLES for i in range(SAMPLES)]
    for y in range(y0, y1):
        for x in range(x0, x1):
            hits, last = 0, WHITE
            for sy in offsets:
                for sx in offsets:
                    ux, uy = (x + sx - ox) / scale, (y + sy - oy) / scale
                    painted = None
                    for shape, fill in glyph:
                        if shape(ux, uy):
                            painted = fill
                    if painted is not None:
                        hits += 1
                        if painted != WHITE:
                            last = painted
            if hits:
                alpha[y][x] = hits / SAMPLES ** 2
                colour[y][x] = last
    return alpha, colour


def long_shadow(alpha, length, strength):
    """Shadow cast down-right at 45 degrees, fading linearly over `length` px."""
    height, width = len(alpha), len(alpha[0])
    shadow = [[0.0] * width for _ in range(height)]
    fade = strength / length
    for y in range(1, height):
        row, above, cast = shadow[y], shadow[y - 1], alpha[y - 1]
        for x in range(1, width):
            row[x] = max(cast[x - 1] * strength, above[x - 1] - fade, 0.0)
    return shadow


def icon(width, height, glyph, box, centre, shadow_length, shadow_strength=0.18, anchor=(12, 12)):
    scale = box / 24
    alpha, colour = raster(width, height, glyph, scale, (centre[0] - anchor[0] * scale, centre[1] - anchor[1] * scale))
    shadow = long_shadow(alpha, shadow_length, shadow_strength)
    pixels = []
    for y in range(height):
        for x in range(width):
            a, s = alpha[y][x], shadow[y][x] * (1 - alpha[y][x])
            total = a + s
            if total <= 0:
                pixels.append((0, 0, 0, 0))
                continue
            r, g, b = colour[y][x]
            pixels.append((round(r * a / total), round(g * a / total), round(b * a / total), round(255 * total)))
    return pixels


def tile(width, height, size, radius, pixels_of_glyph, glyph_size):
    """The glyph composited on its menu tile's gradient, centred on black."""
    left, top = (width - size) // 2, (height - size) // 2
    inside = rounded_rect(left, top, size, size, radius)
    gx, gy = (width - glyph_size) // 2, (height - glyph_size) // 2
    out = []
    for y in range(height):
        for x in range(width):
            hits = sum(inside(x + (i + 0.5) / SAMPLES, y + (j + 0.5) / SAMPLES) for i in range(SAMPLES) for j in range(SAMPLES))
            cover = hits / SAMPLES ** 2
            t = min(1.0, max(0.0, ((x - left) * 0.5 + (y - top)) / (size * 1.5)))
            base = [TILE[0][k] + (TILE[1][k] - TILE[0][k]) * t for k in range(3)]
            colour = [c * cover for c in base]
            if gx <= x < gx + glyph_size and gy <= y < gy + glyph_size:
                r, g, b, a = pixels_of_glyph[(y - gy) * glyph_size + (x - gx)]
                a /= 255
                colour = [colour[k] * (1 - a) + (r, g, b)[k] * a for k in range(3)]
            out.append((round(colour[0]), round(colour[1]), round(colour[2]), 255))
    return out


def png(width, height, pixels):
    rows = b''.join(b'\x00' + bytes(v for p in pixels[y * width:(y + 1) * width] for v in p) for y in range(height))
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xFFFFFFFF)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))


def write(relative, width, height, pixels):
    target = HERE / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(png(width, height, pixels))
    print(relative, width, 'x', height)


def main():
    only = set(sys.argv[1:])
    def wanted(name):
        return not only or name in only
    # Centre the camera's solid silhouette, excluding its decorative shadow.
    # Its asymmetric lens puts the area centroid at (11.18, 12) in glyph units.
    glyph = icon(330, 330, camera(), 196, (165, 165), 62, anchor=(11.18, 12))
    if wanted('icon'):
        write('icon.png', 330, 330, glyph)
    # Action icons: about 130 px drawing box on the stock 265 px canvas.
    if wanted('video'):
        write('telejibo/resources/icons/video.png', 265, 265, icon(265, 265, camera(), 138, (132.5, 132.5), 58, anchor=(11.18, 12)))
    if wanted('settings'):
        write('telejibo/resources/icons/settings.png', 265, 265, icon(265, 265, cog(), 128, (132, 132), 60))
    if wanted('rotate'):
        write('telejibo/resources/icons/rotate.png', 265, 265, icon(265, 265, auto_rotate(), 138, (132.5, 132.5), 58))
    for name, glyph_of in (('landscape', lambda: frame(True)), ('portrait', lambda: frame(False)), ('bell', bell)):
        if wanted(name):
            write('telejibo/resources/icons/%s.png' % name, 265, 265, icon(265, 265, glyph_of(), 138, (132.5, 132.5), 58))


if __name__ == '__main__':
    main()
