# -*- coding: utf-8 -*-
"""用 Pillow 生成 Android 启动图标（各 mipmap 尺寸 + 自适应图标前景）
风格：深青绿 #0F766E 渐变圆角底 + 白色书本图形 + swing 字标
"""
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "android-app",
                    "android", "app", "src", "main", "res")
OUT_ICON = os.path.join(BASE, "mipmap-anydpi-v26")  # 自适应图标 xml
SIZES = {  # density -> px
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192,
}


def lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def draw_icon(size, with_fg=True):
    """绘制图标：渐变圆角底 + 白色书本 + 底部字标"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # 圆角矩形底（渐变）
    r = int(size * 0.18)
    c_top, c_bot = (15, 118, 110), (8, 80, 75)
    for y in range(size):
        t = y / size
        col = lerp(c_top, c_bot, t)
        d.rounded_rectangle([0, y, size, y + 1], radius=r, fill=col + (255,))
    # 白色书本图形（居中偏上）
    pad = size * 0.18
    bw = size * 0.42
    bh = size * 0.32
    x0 = (size - bw) / 2
    y0 = size * 0.22
    # 两页书本
    d.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], radius=int(bw * 0.08), fill=(255, 255, 255, 255))
    d.rounded_rectangle([x0 + bw * 0.5 - bw * 0.02, y0 - bh * 0.12, x0 + bw * 0.5 + bw * 0.02, y0 + bh],
                        radius=int(bw * 0.04), fill=(15, 118, 110, 255))
    # 书本上的文字线条（装饰）
    lw = max(2, int(size * 0.012))
    for i in range(3):
        ly = y0 + bh * (0.25 + i * 0.22)
        d.rectangle([x0 + bw * 0.14, ly, x0 + bw * 0.42, ly + lw], fill=(15, 118, 110, 200))
    # 底部字标 swing
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", int(size * 0.11))
    except Exception:
        font = ImageFont.load_default()
    label = "swing"
    bbox = d.textbbox((0, 0), label, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((size - tw) / 2 - bbox[0], size * 0.66 - bbox[1]), label, font=font, fill=(255, 255, 255, 235))
    return img


def main():
    os.makedirs(OUT_ICON, exist_ok=True)
    for mip, px in SIZES.items():
        d = os.path.join(BASE, mip)
        os.makedirs(d, exist_ok=True)
        icon = draw_icon(px)
        icon.save(os.path.join(d, "ic_launcher.png"))
        # 前景（无字标，给自适应图标用）
        fg = draw_icon(px, with_fg=True)
        fg.save(os.path.join(d, "ic_launcher_foreground.png"))
        print("生成", mip, px, "px")
    # 自适应图标 XML
    xml = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>"""
    with open(os.path.join(OUT_ICON, "ic_launcher.xml"), "w", encoding="utf-8") as f:
        f.write(xml)
    # 背景色
    vals = os.path.join(BASE, "values")
    os.makedirs(vals, exist_ok=True)
    with open(os.path.join(vals, "ic_launcher_background.xml"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0F766E</color>\n</resources>')
    print("自适应图标 XML 已生成")


if __name__ == "__main__":
    main()
