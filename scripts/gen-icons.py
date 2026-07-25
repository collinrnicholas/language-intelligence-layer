#!/usr/bin/env python3
"""Generate Persado-branded PNG icons — purple→magenta gradient with white 'P'."""
import struct, zlib, os

OUT = '/Users/test/dev/Persado/extension/public'
SIZES = {'icon16.png':16, 'icon32.png':32, 'icon48.png':48, 'icon.png':128, 'icon512.png':512}

# Persado brand colors
PURPLE = (92, 45, 145)   # #5C2D91
MAGENTA = (232, 56, 140) # #E8388C
WHITE = (255, 255, 255, 255)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i]-a[i])*t) for i in range(3))

def make_png(size):
    """Build RGBA PNG bytes: gradient bg + white P letterform."""
    # Build pixel rows (RGBA, filter byte 0 = None)
    raw = b''
    for y in range(size):
        raw += b'\x00'  # filter: None
        t = y / (size - 1) if size > 1 else 0
        bg = lerp(PURPLE, MAGENTA, t)
        for x in range(size):
            if is_p_pixel(x, y, size):
                raw += struct.pack('BBBB', *WHITE)
            else:
                raw += struct.pack('BBBB', *bg, 255)
    return raw

def is_p_pixel(x, y, size):
    """Draw a bold 'P' letter centered in the icon."""
    cx, cy = size / 2, size / 2
    # Scale factor relative to icon size
    s = size / 128.0

    # P parameters
    stem_w = max(3, int(6 * s))       # vertical stem width
    stem_x = int(cx - 18 * s)         # left edge of stem
    stem_top = int(cy - 28 * s)       # top of P
    stem_bot = int(cy + 28 * s)       # bottom of P
    bowl_inner_r = int(12 * s)        # inner radius of bowl
    bowl_outer_r = int(24 * s)        # outer radius of bowl
    bowl_cy = int(cy - 10 * s)        # vertical center of bowl
    bowl_cx = stem_x + stem_w + bowl_outer_r  # center of bowl

    # Stem
    if stem_x <= x < stem_x + stem_w and stem_top <= y <= stem_bot:
        return True

    # Bowl (filled ring)
    dx = x - bowl_cx
    dy = y - bowl_cy
    dist = (dx*dx + dy*dy) ** 0.5
    if bowl_inner_r <= dist <= bowl_outer_r:
        # Only the right half of the bowl (don't draw left of stem)
        if x >= stem_x + stem_w:
            return True

    return False

def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

def build_png(size):
    raw = make_png(size)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw))
            + chunk(b'IEND', b''))

if __name__ == '__main__':
    for name, sz in SIZES.items():
        path = os.path.join(OUT, name)
        with open(path, 'wb') as f:
            f.write(build_png(sz))
        print(f'{name} {sz}×{sz} — {os.path.getsize(path)} bytes')
    print('Done')
