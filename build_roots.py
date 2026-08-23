#!/usr/bin/env python3
"""基于词根词缀表的词族构建：生成 word_roots 表（root -> word 映射）。

方法：对词典中高频词（bnc/frq <= 20000）剥一层已知前缀或后缀，
剩余词干（>= 4 字母）作为 root 入库。之后 roots_for_word(word)
即可查得同词根词族（如 act -> action/active/react/actor）。
"""
import os
import re
import sys

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from vocab import db  # noqa: E402

DATA = os.path.join(BASE, "data")

SUFFIXES = [
    "ization", "isation", "ational", "ation", "ition", "ution", "sion",
    "tion", "ness", "ment", "ity", "ety", "ive", "ous", "ious", "eous",
    "ful", "less", "able", "ible", "ally", "ly", "er", "or", "ator",
    "etic", "ist", "ism", "al", "ic", "ing", "ed", "es", "s", "est", "y",
]
# 常用词干词缀（含 WordRoots.md 前缀中的常见项）
PREFIXES = [
    "anti", "auto", "circum", "contra", "counter", "dis", "en", "em",
    "fore", "in", "im", "inter", "intra", "mis", "non", "over", "out",
    "post", "pre", "pro", "re", "semi", "sub", "super", "sur", "trans",
    "ultra", "un", "under", "up", "ab", "ad", "com", "con", "col", "cor",
    "de", "ex", "e", "extra", "hyper", "hypo", "mono", "multi", "per",
    "poly", "tele", "tri", "uni", "be", "bi", "co",
]


def load_roots_md_prefixes():
    """从 WordRoots.md 提取前缀表（去 '-'、小写、去重）。"""
    prefixes = set()
    path = os.path.join(DATA, "word_roots.md")
    if not os.path.exists(path):
        return prefixes
    in_prefix = False
    for line in open(path, encoding="utf-8"):
        if line.startswith("## Prefix"):
            in_prefix = True
            continue
        if line.startswith("## "):
            in_prefix = False
        if in_prefix and "|" in line:
            cells = [c.strip() for c in line.split("|")]
            if len(cells) >= 2 and cells[1] and cells[1] not in ("Prefix",):
                name = cells[1].rstrip("-").strip().lower()
                if 2 <= len(name) <= 6 and re.fullmatch(r"[a-z]+", name):
                    prefixes.add(name)
    return prefixes


def stem_word(word, prefixes):
    """剥一层后缀或前缀得词干；失败返回 None。

    规则：后缀剥离后词干 >= 4 字母直接接受；词干 == 3 且是词典中真实存在的
    单词也接受（如 action -> act）；随后尝试前缀剥离。
    """
    w = word.lower()
    # 后缀剥离（优先取更长的后缀，如 ator 优先于 or）
    best = None
    for suf in sorted(SUFFIXES, key=len, reverse=True):
        if w.endswith(suf):
            stem = w[: len(w) - len(suf)]
            if len(stem) >= 4:
                best = stem
                break
            if len(stem) == 3 and best is None:
                best = stem  # 3 字母词干暂存，稍后校验是否为词
            if len(stem) == 2:
                # 2 字母词干补全：尝试加一个字母成为真实单词（action -> act）
                cands = [(rank, s) for s, rank in _KNOWN_WORDS_RANK.items()
                         if s.startswith(stem)]
                if cands:
                    best = min(cands)[1]
                    break
    if best and (len(best) >= 4 or best in _KNOWN_WORDS_RANK):
        return best
    # 前缀剥离
    for pre in prefixes:
        if w.startswith(pre):
            stem = w[len(pre):]
            if len(stem) >= 4 or (len(stem) == 3 and stem in _KNOWN_WORDS_RANK):
                return stem
    return None


def main():
    global _KNOWN_WORDS_RANK
    conn = db.connect()
    db.init_db(conn)
    # 3 字母短词的词频映射（bnc 优先），用于词干补全与校验
    _KNOWN_WORDS_RANK = {}
    for r in conn.execute(
            """SELECT word, bnc, frq FROM dictionary
               WHERE LENGTH(word) = 3"""):
        vals = [v for v in (r["bnc"] or 0, r["frq"] or 0) if v > 0]
        _KNOWN_WORDS_RANK[r["word"]] = min(vals) if vals else 10 ** 9
    prefixes = set(PREFIXES) | load_roots_md_prefixes()
    print(f"前缀表: {len(prefixes)} 个")

    conn.execute("DELETE FROM word_roots")
    rows = conn.execute(
        """SELECT word FROM dictionary
           WHERE (bnc > 0 AND bnc <= 20000) OR (frq > 0 AND frq <= 20000)"""
    ).fetchall()
    words = [r["word"] for r in rows]
    print(f"待分析高频词: {len(words)}")

    batch = []
    n = 0
    for w in words:
        stem = stem_word(w, prefixes)
        if not stem:
            continue
        batch.append((stem, w))
        n += 1
        if len(batch) >= 2000:
            conn.executemany(
                "INSERT INTO word_roots (root, word) VALUES (?,?)", batch)
            conn.commit()
            batch.clear()
    if batch:
        conn.executemany("INSERT INTO word_roots (root, word) VALUES (?,?)", batch)
        conn.commit()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    total = db.roots_table_size(conn)
    conn.close()
    print(f"完成: 生成 {n} 条词根映射，word_roots 表共 {total} 行")

    # 抽验：spect / act
    conn = db.connect()
    db.init_db(conn)
    for probe in ("inspect", "action", "energy"):
        fam = db.roots_for_word(conn, probe)
        print(f"  {probe} -> {fam[:10]}")
    conn.close()


if __name__ == "__main__":
    main()
