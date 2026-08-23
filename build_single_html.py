#!/usr/bin/env python3
"""生成手机可用的「单文件版」生词本 HTML：
把 style.css / app.js / 全部词典分片 / 生词本数据 全部内联进一个 HTML，
手机只需打开这一个文件即可使用（不依赖任何外部资源加载）。

用法: python build_single_html.py
输出: vocab-app/生词本-单文件版.html
"""
import os
import re

BASE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BASE, "web")
DATA = os.path.join(WEB, "data")
OUT = os.path.join(BASE, "生词本-单文件版.html")


def main():
    html = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()

    # 1. 内联 CSS
    css = open(os.path.join(WEB, "style.css"), encoding="utf-8").read()
    html = html.replace('<link rel="stylesheet" href="style.css">',
                        "<style>\n" + css + "\n</style>")

    # 2. 内联词典分片 + 元信息 + 生词本 + 外刊文章库（在 app.js 之前）
    scripts = []
    scripts.append(open(os.path.join(DATA, "meta.js"), encoding="utf-8").read())
    scripts.append(open(os.path.join(DATA, "words.js"), encoding="utf-8").read())
    for f in sorted(os.listdir(DATA)):
        if re.fullmatch(r"dict_[a-z]+\.js", f):
            scripts.append(open(os.path.join(DATA, f), encoding="utf-8").read())
    for f in sorted(os.listdir(DATA)):
        if re.fullmatch(r"articles\d*\.js", f):
            scripts.append(open(os.path.join(DATA, f), encoding="utf-8").read())
    inline_data = "\n".join(scripts)

    # 3. 内联 app.js（在数据之后）
    appjs = open(os.path.join(WEB, "app.js"), encoding="utf-8").read()

    # 4. 去掉外部引用，替换为内联内容
    html = html.replace('<script src="data/meta.js"></script>', "")
    html = html.replace('<script src="data/words.js"></script>', "")
    for f in sorted(os.listdir(DATA)):
        if re.fullmatch(r"articles\d*\.js", f):
            html = html.replace('<script src="data/%s"></script>' % f, "")
    html = html.replace('<script src="app.js"></script>',
                        "<script>\n" + inline_data + "\n" + appjs + "\n</script>")

    # 5. 单文件版无需 manifest/icon（file:// 下无意义），保留无妨但移除报错风险
    html = html.replace('<link rel="manifest" href="manifest.json">', "")
    html = html.replace('<link rel="icon" href="icon.svg" type="image/svg+xml">', "")
    html = html.replace('<meta name="theme-color" content="#2563eb">', "")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(html)
    size_mb = os.path.getsize(OUT) / 1048576
    print(f"单文件版已生成: {OUT}")
    print(f"大小: {size_mb:.2f} MB（词典 {len(scripts) - 2} 个分片已内联）")


if __name__ == "__main__":
    main()
