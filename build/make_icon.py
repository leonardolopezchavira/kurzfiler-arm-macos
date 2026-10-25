"""Draws the KurzFiler app icon and packs it into an .icns file."""
import io, math, struct, sys
from PIL import Image, ImageDraw, ImageFilter

S = 4096  # supersampled canvas (4x of 1024)
k = S / 1024

def rr(draw, box, r, fill):
    draw.rounded_rectangle([v * k for v in box], radius=r * k, fill=fill)

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
# soft drop shadow
sh = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(sh).rounded_rectangle([100 * k, 118 * k, 924 * k, 942 * k], radius=185 * k, fill=(0, 0, 0, 110))
sh = sh.filter(ImageFilter.GaussianBlur(18 * k))
img.alpha_composite(sh)

# body: vertical gradient charcoal
body = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = Image.new('RGBA', (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / S
    c = (int(58 - 30 * t), int(60 - 31 * t), int(64 - 32 * t), 255)
    gd.line([(0, y), (S, y)], fill=c)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([100 * k, 100 * k, 924 * k, 924 * k], radius=185 * k, fill=255)
body.paste(grad, (0, 0), mask)
img.alpha_composite(body)
d = ImageDraw.Draw(img)
# subtle top highlight line
d.rounded_rectangle([100 * k, 100 * k, 924 * k, 924 * k], radius=185 * k, outline=(255, 255, 255, 38), width=int(4 * k))

# LCD bezel + panel
rr(d, (168, 196, 856, 560), 34, (14, 16, 18, 255))
lcd = Image.new('RGBA', (S, S), (0, 0, 0, 0))
lg = ImageDraw.Draw(lcd)
x0, y0, x1, y1 = [v * k for v in (190, 218, 834, 538)]
for y in range(int(y0), int(y1)):
    t = (y - y0) / (y1 - y0)
    lg.line([(x0, y), (x1, y)], fill=(int(30 + 18 * (1 - t)), int(64 + 40 * (1 - t)), int(46 + 20 * (1 - t)), 255))
lmask = Image.new('L', (S, S), 0)
ImageDraw.Draw(lmask).rounded_rectangle([x0, y0, x1, y1], radius=22 * k, fill=255)
panel = Image.new('RGBA', (S, S), (0, 0, 0, 0)); panel.paste(lcd, (0, 0), lmask)
img.alpha_composite(panel)
d = ImageDraw.Draw(img)

# waveform on the LCD (decaying tone)
pts = []
for i in range(0, 601):
    x = 222 + i * (580 / 600)
    t = i / 600
    env = math.exp(-2.6 * t) * (1 - math.exp(-60 * t))
    y = 378 - 118 * env * math.sin(2 * math.pi * 7.5 * t) * (0.75 + 0.25 * math.sin(2 * math.pi * 31 * t))
    pts.append((x * k, y * k))
glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(glow).line(pts, fill=(170, 255, 160, 150), width=int(16 * k), joint='curve')
glow = glow.filter(ImageFilter.GaussianBlur(10 * k))
img.alpha_composite(glow)
d = ImageDraw.Draw(img)
d.line(pts, fill=(196, 255, 182, 255), width=int(9 * k), joint='curve')
# baseline + loop markers
d.line([(222 * k, 378 * k), (802 * k, 378 * k)], fill=(150, 220, 140, 70), width=int(3 * k))

# keyboard
kx0, ky0, kx1, ky1 = 168, 612, 856, 846
rr(d, (kx0, ky0, kx1, ky1), 26, (14, 16, 18, 255))
n = 10
w = (kx1 - kx0 - 24) / n
for i in range(n):
    a = kx0 + 12 + i * w
    rr(d, (a + 3, ky0 + 12, a + w - 3, ky1 - 12), 10, (246, 245, 240, 255))
for i in range(n - 1):
    if i % 7 in (2, 6):
        continue
    a = kx0 + 12 + (i + 1) * w
    rr(d, (a - w * 0.3, ky0 + 12, a + w * 0.3, ky0 + 150), 7, (24, 25, 28, 255))

out = img.resize((1024, 1024), Image.LANCZOS)
out.save(sys.argv[1] + '.png')

def png(sz):
    b = io.BytesIO(); out.resize((sz, sz), Image.LANCZOS).save(b, 'PNG'); return b.getvalue()
entries = [(b'icp4', 16), (b'icp5', 32), (b'icp6', 64), (b'ic07', 128), (b'ic08', 256), (b'ic09', 512), (b'ic10', 1024),
           (b'ic11', 32), (b'ic12', 64), (b'ic13', 256), (b'ic14', 512)]
blob = b''
for t, sz in entries:
    data = png(sz)
    blob += t + struct.pack('>I', len(data) + 8) + data
open(sys.argv[1] + '.icns', 'wb').write(b'icns' + struct.pack('>I', len(blob) + 8) + blob)
print('icon written')
