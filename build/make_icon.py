from PIL import Image, ImageDraw, ImageFilter
import sys

def rrect(draw, box, r, fill):
    x0, y0, x1, y1 = box
    draw.rectangle([x0 + r, y0, x1 - r, y1], fill=fill)
    draw.rectangle([x0, y0 + r, x1, y1 - r], fill=fill)
    for cx, cy in [(x0, y0), (x1 - 2*r, y0), (x0, y1 - 2*r), (x1 - 2*r, y1 - 2*r)]:
        draw.ellipse([cx, cy, cx + 2*r, cy + 2*r], fill=fill)
S = 2048  # draw big, downscale for smooth edges
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# Background: rounded square with vertical purple gradient (macOS icon grid: 824/1024 body)
pad = int(S * 100 / 1024); r = int(S * 185 / 1024)
grad = Image.new("RGBA", (S, S))
gd = ImageDraw.Draw(grad)
top, bot = (58, 34, 120), (16, 14, 32)
for y in range(S):
    t = y / S
    gd.line([(0, y), (S, y)], fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)) + (255,))
mask = Image.new("L", (S, S), 0)
rrect(ImageDraw.Draw(mask), [pad, pad, S - pad, S - pad], r, 255)
# soft drop shadow
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rrect(ImageDraw.Draw(shadow), [pad, pad + 24, S - pad, S - pad + 24], r, (0, 0, 0, 120))
img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(30)))
img.paste(grad, (0, 0), mask)
d = ImageDraw.Draw(img)

# Stars + moon
for x, y, rr in [(560, 470, 10), (1500, 420, 14), (1640, 640, 8), (430, 760, 8), (1250, 330, 7)]:
    d.ellipse([x - rr, y - rr, x + rr, y + rr], fill=(230, 220, 255, 220))
moon = Image.new("L", (S, S), 0); md = ImageDraw.Draw(moon)
md.ellipse([1580, 250, 1790, 460], fill=255); md.ellipse([1630, 220, 1840, 430], fill=0)
img.paste(Image.new("RGBA", (S, S), (250, 228, 160, 255)), (0, 0), moon)
d = ImageDraw.Draw(img)

cx = S // 2
body = (139, 92, 246)      # accent purple
dark = (44, 30, 92)
# Ear tufts
d.polygon([(cx - 470, 760), (cx - 520, 470), (cx - 250, 680)], fill=body)
d.polygon([(cx + 470, 760), (cx + 520, 470), (cx + 250, 680)], fill=body)
# Head / body
d.ellipse([cx - 520, 620, cx + 520, 1700], fill=body)
# Belly
d.ellipse([cx - 330, 1180, cx + 330, 1680], fill=(167, 139, 250))
for i, yy in enumerate([1300, 1400, 1500]):
    for xx in range(-180 + (i % 2) * 60, 200, 120):
        d.arc([cx + xx - 40, yy - 25, cx + xx + 40, yy + 35], 20, 160, fill=(124, 82, 230), width=12)
# Facial disc
for sx in (-1, 1):
    ex = cx + sx * 230
    d.ellipse([ex - 250, 760, ex + 250, 1260], fill=dark)
    d.ellipse([ex - 195, 815, ex + 195, 1205], fill=(250, 245, 255))
    d.ellipse([ex - 130, 880, ex + 130, 1140], fill=(251, 191, 36))
    d.ellipse([ex - 75, 935, ex + 75, 1085], fill=(15, 12, 28))
    d.ellipse([ex - 40 + sx * 10, 950, ex + 5 + sx * 10, 995], fill=(255, 255, 255))
# Beak
d.polygon([(cx - 70, 1200), (cx + 70, 1200), (cx, 1340)], fill=(251, 191, 36))

out = img.resize((1024, 1024), Image.LANCZOS)
out.save(sys.argv[1])
