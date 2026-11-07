# Draws the SWD Guard icons (a green shield with a check mark) at 16/32/48/128 px. Needs Pillow:
#   python3 scripts/make-icons.py
from pathlib import Path
from PIL import Image, ImageDraw

out = Path(__file__).resolve().parent.parent / "icons"
out.mkdir(exist_ok=True)
S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
shield = [(256, 28), (456, 96), (440, 300), (256, 488), (72, 300), (56, 96)]
d.polygon(shield, fill=(4, 120, 87, 255))
inner = [(256, 70), (414, 124), (400, 290), (256, 440), (112, 290), (98, 124)]
d.polygon(inner, fill=(11, 31, 26, 255))
d.line([(170, 262), (232, 324), (348, 192)], fill=(110, 231, 183, 255), width=44, joint="curve")
for n in (16, 32, 48, 128):
    img.resize((n, n), Image.LANCZOS).save(out / f"icon{n}.png", optimize=True)
print("icons written to", out)
