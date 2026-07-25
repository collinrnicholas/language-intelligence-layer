#!/usr/bin/env python3
"""Generate Persado [P] icons — red brackets, black P, white bg."""
import struct, zlib, os

OUT = '/Users/test/dev/Persado/extension/public'
SIZES = {'icon16.png':16, 'icon32.png':32, 'icon48.png':48, 'icon.png':128, 'icon512.png':512}

RED = (220, 40, 40)
BLACK = (26, 17, 40)
WHITE = (255, 255, 255, 255)

def make_png(size):
    raw = b''
    for y in range(size):
        raw += b'\x00'
        for x in range(size):
            c = pixel_color(x, y, size)
            raw += struct.pack('BBBB', *c)
    return raw

def pixel_color(x, y, size):
    s = size / 128.0

    # P letter bounds
    stem_left = int(36 * s)
    stem_right = int(50 * s)
    stem_top = int(28 * s)
    stem_bot = int(100 * s)

    bowl_cx = stem_right + int(16 * s)
    bowl_cy = int(48 * s)
    bowl_outer = int(22 * s)
    bowl_inner = int(10 * s)

    # Left bracket
    lb_left = int(18 * s)
    lb_right = int(24 * s)

    # Right bracket
    rb_left = int(104 * s)
    rb_right = int(110 * s)

    # Check P letter
    if stem_left <= x < stem_right and stem_top <= y <= stem_bot:
        return BLACK + (255,)
    dx = x - bowl_cx
    dy = y - bowl_cy
    dist = (dx*dx + dy*dy) ** 0.5
    if bowl_inner <= dist <= bowl_outer and x >= stem_right:
        return BLACK + (255,)

    # Check brackets
    bracket_top = int(20 * s)
    bracket_bot = int(108 * s)
    bracket_bar_h = int(5 * s)

    if y >= bracket_top and y <= bracket_bot:
        # Left bracket vertical bar + horizontal bars
        if (lb_left <= x < lb_right and bracket_top <= y <= bracket_bot):  # vertical
            if not (bracket_top + bracket_bar_h < y < bracket_bot - bracket_bar_h):
                return RED + (255,)
            elif lb_left + bracket_bar_h <= x < lb_right - bracket_bar_h:
                return RED + (255,) if (y <= bracket_top + bracket_bar_h or y >= bracket_bot - bracket_bar_h) else WHITE
            else:
                return RED + (255,)
        # Right bracket
        if (rb_left <= x < rb_right and bracket_top <= y <= bracket_bot):
            if not (bracket_top + bracket_bar_h < y < bracket_bot - bracket_bar_h):
                return RED + (255,)
            elif rb_left + bracket_bar_h <= x < rb_right - bracket_bar_h:
                return RED + (255,) if (y <= bracket_top + bracket_bar_h or y >= bracket_bot - bracket_bar_h) else WHITE
            else:
                return RED + (255,)

        # Simplified bracket approach: just draw solid red brackets
        if lb_left <= x < lb_right:
            return RED + (255,)
        if rb_left <= x < rb_right:
            return RED + (255,)

    return WHITE

def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

def build_png(size):
    raw = make_png(size)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
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
