"""同根词模块（规划 3.3）。

双方案合并：
  方案一（首选）：word_roots 词根词族表直接查表；
  方案二（兜底）：词形归并——去词缀得到词干，在词库中查找同词干的常见词。
结果合并、去重、按词频排序，截取前 8 个。
"""
import re

# 常见派生词缀（仅用于兜底词形归并，宁缺毋滥）
_SUFFIXES = [
    "ization", "isation", "ational", "fulness", "ousness",
    "ation", "ition", "ution", "sion", "tion", "ness", "ment",
    "ity", "ety", "ive", "ous", "ious", "eous", "ful", "less",
    "able", "ible", "ally", "ally", "ally", "ly", "er", "or",
    "ist", "ism", "al", "ic", "ing", "ed", "es", "s",
]
_PREFIXES = ["un", "re", "in", "im", "dis", "pre", "pro", "mis", "over", "under"]


def stem_of(word):
    """保守的词形归并：只剥一层后缀，词干至少保留 4 个字母。"""
    w = word.lower()
    for suf in _SUFFIXES:
        if w.endswith(suf) and len(w) - len(suf) >= 4:
            return w[: len(w) - len(suf)]
    return w


def find_roots(conn, word, target_row, max_count=8):
    """返回同根词列表（字符串数组），可直接存 roots 字段。"""
    from . import db

    found = {}

    # 方案一：词根词族表
    for w in db.roots_for_word(conn, word):
        found[w] = True

    # 方案二：词形归并兜底
    if len(found) < max_count:
        stem = stem_of(word)
        if len(stem) >= 4:
            for row in db.dict_words_with_stem(conn, stem):
                cand = row["word"]
                if cand != word:
                    found.setdefault(cand, True)
            # 反向：目标词可能是别人的词干（如 act -> action）
            for row in db.dict_words_with_stem(conn, word):
                cand = row["word"]
                if cand != word and len(cand) > len(word):
                    found.setdefault(cand, True)

    # 按词频排序截取
    def rank_of(w):
        r = db.dict_query(conn, w)
        if not r:
            return 10 ** 9
        vals = [v for v in (r["bnc"] or 0, r["frq"] or 0) if v > 0]
        if vals:
            return min(vals)
        collins = r["collins"] or 0
        return 100000 - collins * 10000 if collins else 10 ** 9

    # 只保留纯字母单词，剔除短语条目
    found = {w for w in found if re.fullmatch(r"[a-z]+", w)}
    result = sorted(found, key=rank_of)
    return result[:max_count]
