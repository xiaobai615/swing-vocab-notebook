#!/usr/bin/env python3
"""用《牛津高阶（第10版 英汉双解）V11_8.mdx》替换生词本词典数据。

行为：
  1. 解析牛津 MDX（28 万词条），提取 音标(英式+美式)/词性/中文释义(多义项)/例句(含中文)
  2. 合并进 dictionary 表：translation/example/phonetic 用牛津覆盖，新增 source='oald' 标记；
     bnc/frq/exchange/collins 保留 ECDICT 原值（形近词排除与常用词池不受影响）
  3. 同步刷新生词本(notebook)已有词条的 释义/例句/音标（进度字段不动）

用法: python import_oald.py [mdx路径]
"""
import os
import re
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)
sys.path.insert(0, os.path.join(BASE, "tools"))

from vocab import db  # noqa: E402
from mdx_reader import MDX  # noqa: E402

_WORD_RE = re.compile(r"^[a-z]+(?:[''-][a-z]+)*$")
_INLINE_TAG_RE = re.compile(r"</?(?:span|b|i|l|font|em|strong|sup|sub|a)[^>]*>", re.I)
_TAG_RE = re.compile(r"<[^>]+>")


def clean(s):
    s = s or ""
    s = _INLINE_TAG_RE.sub("", s)
    s = _TAG_RE.sub(" ", s)
    s = s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"') \
        .replace("&amp;", "&").replace("&nbsp;", " ")
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\s+([.,;:!?])", r"\1", s)
    return s


def extract_phonetics(html):
    """主词音标：英式(phons_br) + 美式(phons_n_am) 各取一个，相同去重。"""
    ph = []
    for grp in ("phons_br", "phons_n_am"):
        blk = re.search(r'<div class="%s".*?</div>' % grp, html, re.DOTALL)
        if blk:
            mm = re.search(r'<span class="phon"[^>]*>(.*?)</span>',
                           blk.group(0), re.DOTALL)
            if mm:
                p = clean(mm.group(1))
                if p.startswith("/") and p not in ph:
                    ph.append(p)
    return " ".join(ph)


# 牛津词性 -> 中文映射
_POS_MAP = {
    "verb": "动词", "noun": "名词", "adjective": "形容词", "adverb": "副词",
    "preposition": "介词", "conjunction": "连词", "pronoun": "代词",
    "determiner": "限定词", "number": "数词", "numeral": "数词",
    "modal verb": "情态动词", "auxiliary verb": "助动词", "aux": "助动词",
    "exclamation": "感叹词", "interjection": "感叹词", "phrase": "短语",
    "article": "冠词", "prefix": "前缀", "suffix": "后缀",
    "combining form": "构词成分", "abbreviation": "缩写", "symbol": "符号",
    "quantifier": "量词", "particle": "小品词", "ordinal": "序数词",
    "cardinal": "基数词", "gerund": "动名词", "past participle": "过去分词",
    "present participle": "现在分词", "past tense": "过去式",
}


def _pos_cn(pos):
    pos = (pos or "").strip().lower()
    return _POS_MAP.get(pos, pos)


def extract_pos(html):
    """词条级词性（webtop 首个 pos）。"""
    m = re.search(r'<span class="pos"[^>]*>([^<]+)</span>', html)
    return m.group(1).strip().lower() if m else ""


def extract_senses(html):
    """主义项列表 -> [(中文词性, 中文释义), ...]。
    优先 senses_multiple，其次 sense_single；每个义项优先用自身 pos，缺省继承词条级。
    """
    pos_global = extract_pos(html)
    block = None
    for cls in ("senses_multiple", "sense_single"):
        ol = re.search(r'<ol class="%s".*?</ol>' % cls, html, re.DOTALL)
        if ol:
            block = ol.group(0)
            break
    if block is None:
        return []
    senses = []
    # 按 li.sense 切段（前瞻防止匹配到 examples 内的 li）
    parts = re.split(r'(?=<li class="sense")', block)
    for seg in parts:
        if not seg.startswith('<li class="sense"'):
            continue
        pos = pos_global
        mp = re.search(r'<span class="pos"[^>]*>([^<]+)</span>', seg)
        if mp:
            pos = mp.group(1).strip().lower()
        md = re.search(
            r'<span class="def"[^>]*>(.*?)</span>\s*<defT>(.*?)</defT>',
            seg, re.DOTALL)
        if not md:
            continue
        cn = clean(re.sub(r"<[^>]+>", " ", md.group(2)))
        if cn:
            senses.append((_pos_cn(pos), cn))
    return senses


def extract_example(html, word):
    """取第一个含目标词且 <= 100 字的例句（优先 x，其次 unx）。"""
    best = ""
    for cls in ("x", "unx"):
        for m in re.finditer(r'<span class="%s"[^>]*>(.*?)</span>' % cls,
                             html, re.DOTALL):
            en = clean(m.group(1))
            if not en:
                continue
            if word.lower() in en.lower() and len(en) <= 100:
                return en
            if not best or len(en) < len(best):
                best = en
    return best


def build_translation(pos, senses):
    lines = []
    for p, cn in senses:
        line = f"{p} {cn}".strip()
        if line and line not in lines:
            lines.append(line)
    return "\n".join(lines)


def main(mdx_path):
    conn = db.connect()
    db.init_db(conn)
    # 新增 source 标记列
    cols = [r[1] for r in conn.execute("PRAGMA table_info(dictionary)")]
    if "source" not in cols:
        conn.execute("ALTER TABLE dictionary ADD COLUMN source TEXT DEFAULT ''")

    mdx = MDX(mdx_path)
    total = len(mdx)
    print(f"牛津词条: {total}")

    t0 = time.time()
    upd = ins = n = 0
    batch_u, batch_i = [], []
    for key, html in mdx.items():
        word = (key or "").strip().lower()
        if not _WORD_RE.match(word) or len(word) > 30:
            continue
        senses = extract_senses(html)
        trans = build_translation("", senses)
        if not trans and not extract_phonetics(html):
            continue  # 无释义无音标（可能是跳转/图片页）
        example = extract_example(html, word)
        phon = extract_phonetics(html)
        n += 1
        batch_u.append((trans, example, phon, word))
        if len(batch_u) >= 3000:
            conn.executemany(
                "UPDATE dictionary SET translation=?, example=?, phonetic=?, "
                "source='oald' WHERE word=?", batch_u)
            conn.commit()
            upd += conn.total_changes if False else 0
            batch_u.clear()
        if n % 20000 == 0:
            print(f"\r已解析 {n}/{total}", end="", flush=True)
    if batch_u:
        conn.executemany(
            "UPDATE dictionary SET translation=?, example=?, phonetic=?, "
            "source='oald' WHERE word=?", batch_u)
        conn.commit()
    print(f"\r解析完成 {n} 词，耗时 {time.time()-t0:.1f}s")

    # 统计：多少词条在库中被更新
    upd_count = conn.execute(
        "SELECT COUNT(*) c FROM dictionary WHERE source='oald'").fetchone()["c"]
    print(f"牛津替换词条数: {upd_count}")

    # 同步刷新生词本已有词条（保留进度字段）
    nb_rows = conn.execute("SELECT word FROM notebook").fetchall()
    nb_upd = 0
    for r in nb_rows:
        row = conn.execute(
            "SELECT translation, example, phonetic FROM dictionary WHERE word=?",
            (r["word"],)).fetchone()
        if row and row["translation"]:
            conn.execute(
                "UPDATE notebook SET translation=?, example=?, phonetic=? WHERE word=?",
                (row["translation"], row["example"] or "", row["phonetic"] or "",
                 r["word"]))
            nb_upd += 1
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    print(f"生词本同步刷新: {nb_upd} 词")
    print("完成")


if __name__ == "__main__":
    p = sys.argv[1] if len(sys.argv) > 1 \
        else r"D:\PSsucai\牛津高阶（第10版 英汉双解） V11_8.mdx"
    main(p)
