#!/usr/bin/env python3
"""将柯林斯高阶英汉词典(.mdx) 与 ipa-dict 音标导入 dictionary 表。

用法:
    python import_mdx.py [柯林斯.mdx 路径] [en_US.txt 路径]

行为：
  - 词条解析：词性+中文释义(text_blue)、例句(li 内第一句)、柯林斯星级(★)
  - 与已有 ECDICT 词条合并：已存在的词补例句/释义/星级；新词直接插入
  - 音标：从 en_US.txt 补充 phonetic（美式，格式 /.../）
"""
import os
import re
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(BASE, "tools")
sys.path.insert(0, BASE)
sys.path.insert(0, TOOLS)

from vocab import db  # noqa: E402
from mdx_reader import MDX  # noqa: E402

_WORD_RE = re.compile(r"^[a-z]+(?:[''-][a-z]+)*$")
_TAG_RE = re.compile(r"<[^>]+>")
_INLINE_TAG_RE = re.compile(r"</?(?:span|b|i|l|font|em|strong)[^>]*>", re.I)


def clean_text(s):
    s = s or ""
    # 内联标签（如 <span class='text_blue'>emerge</span>d）直接删除，不留空格
    s = _INLINE_TAG_RE.sub("", s)
    s = _TAG_RE.sub(" ", s)
    s = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"') \
        .replace("&amp;", "&").replace("&nbsp;", " ")
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([.,;:!?])", r"\1", s)
    return s


def count_stars(html):
    m = re.search(r"<font color=gold>\s*(★+)", html)
    return len(m.group(1)) if m else 0


def extract_senses(html):
    """从 caption 段提取 (pos, cn_translation) 列表。"""
    senses = []
    for cap in re.findall(r'<div class="caption">(.*?)</div>', html, re.DOTALL):
        st = re.search(r'<span class="st"[^>]*>(.*?)</span>', cap, re.DOTALL)
        tb = re.search(r'<span class="text_blue">(.*?)</span>', cap, re.DOTALL)
        pos = clean_text(st.group(1)) if st else ""
        trans = clean_text(tb.group(1)) if tb else ""
        if trans:
            senses.append((pos, trans))
    return senses


def extract_examples(html, word):
    """从 <li><p>英文句</p><p>中文句</p></li> 提取例句；返回 (例句, 例句中文)。"""
    items = []
    for li in re.findall(r"<li\s*>(.*?)</li>", html, re.DOTALL):
        paras = re.findall(r"<p>(.*?)</p>", li, re.DOTALL)
        if not paras:
            continue
        en = clean_text(paras[0])
        cn = clean_text(paras[1]) if len(paras) > 1 else ""
        if en:
            items.append((en, cn))
    if not items:
        return None, None
    # 优先：包含单词本身、长度 <= 100 的第一句
    wl = word.lower()
    for en, cn in items:
        if wl in en.lower() and len(en) <= 100:
            return en, cn
    # 否则取最短句
    best = min(items, key=lambda x: len(x[0]))
    return best


def build_translation(senses):
    """多义项组装为多行文本：'POS 词义' 每行一个义项。"""
    lines = []
    for pos, trans in senses:
        lines.append(f"{pos} {trans}".strip())
    return "\n".join(lines)


def load_ipa(path):
    ipa = {}
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.rstrip("\n")
                if "\t" in line:
                    w, p = line.split("\t", 1)
                    ipa[w.lower().strip()] = p.strip()
    return ipa


def main(mdx_path, ipa_path):
    conn = db.connect()
    db.init_db(conn)
    ipa = load_ipa(ipa_path)
    print(f"音标数据: {len(ipa)} 词")

    mdx = MDX(mdx_path)
    print(f"柯林斯词条: {len(mdx)}")

    t0 = time.time()
    batch = []
    n_insert = n_update = 0
    for key, html in mdx.items():
        word = (key or "").strip().lower()
        if not _WORD_RE.match(word) or len(word) > 30:
            continue
        senses = extract_senses(html)
        trans = build_translation(senses)
        if not trans:
            continue
        ex, ex_cn = extract_examples(html, word)
        example = ex or ""
        stars = count_stars(html)
        phon = ipa.get(word, "")

        existing = db.dict_query(conn, word)
        if existing:
            # 合并：例句/释义/星级用柯林斯覆盖；音标优先 ipa-dict 标准 IPA
            new_ex = example or existing["example"] or ""
            new_ph = phon or existing["phonetic"] or ""
            new_collins = stars or existing["collins"] or 0
            new_trans = trans or existing["translation"] or ""
            if (new_ex != existing["example"] or new_ph != existing["phonetic"]
                    or new_collins != existing["collins"]
                    or new_trans != existing["translation"]):
                conn.execute(
                    "UPDATE dictionary SET example=?, phonetic=?, collins=?, "
                    "translation=? WHERE word=?",
                    (new_ex, new_ph, new_collins, new_trans, word))
                conn.commit()
                n_update += 1
        else:
            batch.append((word, phon, "", trans, example, "", 0, 0, stars, "",
                          len(word)))
            n_insert += 1
        if len(batch) >= 2000:
            conn.executemany(
                "INSERT INTO dictionary (word, phonetic, definition, translation, "
                "example, exchange, bnc, frq, collins, tag, wlen) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                batch)
            conn.commit()
            batch.clear()
        if (n_insert + n_update) % 5000 == 0:
            print(f"\r已处理 {(n_insert + n_update)} 词", end="", flush=True)
    if batch:
        conn.executemany(
            "INSERT INTO dictionary (word, phonetic, definition, translation, "
            "example, exchange, bnc, frq, collins, tag, wlen) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            batch)
        conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    print(f"\n完成: 新增 {n_insert}, 更新 {n_update}, 耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    mdx_path = sys.argv[1] if len(sys.argv) > 1 \
        else r"D:\Download\柯林斯高阶英汉词典.mdx"
    ipa_path = sys.argv[2] if len(sys.argv) > 2 \
        else os.path.join(BASE, "data", "en_US.txt")
    main(mdx_path, ipa_path)
