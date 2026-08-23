"""M5 形近词生成模块（规划 3.4）。

算法：Damerau-Levenshtein（OSA）编辑距离 <= 2，
或两词长度均 >= 5 且最长公共前缀 >= 4；
排除目标词本身及其词形变化（复数/时态等）；
排序：编辑距离升序 -> 词频降序；取前 6 个，不足 3 个放宽到距离 3 补一轮。
"""
from . import db

# 候选池缓存（按数据库文件路径键控）：同一库同长度窗口只查一次。
# 仅对文件型数据库启用；:memory: 测试库不缓存，避免跨库污染。
_POOL_CACHE = {}


def _cached_pool(conn, min_len, max_len, common_only):
    try:
        file = conn.execute("PRAGMA database_list").fetchone()["file"]
    except Exception:
        file = None
    if not file or file == ":memory:":
        return db.dict_candidates_by_length(conn, min_len, max_len, common_only)
    key = (file, min_len, max_len, common_only)
    if key not in _POOL_CACHE:
        _POOL_CACHE[key] = db.dict_candidates_by_length(conn, min_len, max_len,
                                                        common_only)
    return _POOL_CACHE[key]

_POSSIBLE_SUFFIXES = ("'s",)


def dl_distance(a, b, threshold=3):
    """Optimal String Alignment 距离，带阈值提前退出。"""
    la, lb = len(a), len(b)
    if abs(la - lb) > threshold:
        return threshold + 1
    # 只保留两行 DP
    prev2 = None
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        row_min = cur[0]
        ca = a[i - 1]
        for j in range(1, lb + 1):
            cost = 0 if ca == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if (i > 1 and j > 1 and ca == b[j - 2]
                    and a[i - 2] == b[j - 1] and prev2 is not None):
                cur[j] = min(cur[j], prev2[j - 2] + 1)
            if cur[j] < row_min:
                row_min = cur[j]
        if row_min > threshold:
            return threshold + 1
        prev2, prev = prev, cur
    return prev[lb]


def common_prefix_len(a, b):
    n = 0
    for x, y in zip(a, b):
        if x != y:
            break
        n += 1
    return n


def _exchange_forms(exchange):
    """解析 ECDICT exchange 字段，返回词形变化集合与 lemma。"""
    forms, lemma = set(), None
    if not exchange:
        return forms, lemma
    for item in exchange.split("/"):
        if ":" not in item:
            continue
        key, val = item.split(":", 1)
        if key == "0":
            lemma = val
        elif key in ("p", "d", "i", "3", "r", "t", "s", "1"):
            forms.add(val)
    return forms, lemma


def _rank(row):
    """词频排序键：bnc 优先，其次 frq，再其次柯林斯星级；均无则排最后。"""
    bnc = row["bnc"] or 0
    frq = row["frq"] or 0
    vals = [v for v in (bnc, frq) if v > 0]
    if vals:
        return min(vals)
    collins = row["collins"] or 0
    return 100000 - collins * 10000 if collins else 10 ** 9


def find_confusables(conn, word, target_row, max_count=6, min_count=3):
    """为 word 生成形近词列表 [{word, trans}]，直接可存 confusables 字段。"""
    target_forms, target_lemma = _exchange_forms(target_row["exchange"])
    pool = _cached_pool(conn, max(1, len(word) - 2), len(word) + 2, True)

    def collect(threshold):
        hits = []
        for row in pool:
            cand = row["word"]
            if cand == word or cand in target_forms:
                continue
            c_forms, c_lemma = _exchange_forms(row["exchange"])
            # 排除互为词形变化 / 同 lemma 的变体
            if word in c_forms:
                continue
            if target_lemma and c_lemma and target_lemma == c_lemma:
                continue
            if target_lemma and cand == target_lemma:
                continue
            d = dl_distance(word, cand, threshold)
            if d <= threshold:
                hits.append((d, _rank(row), cand, row["translation"]))
            elif (d <= threshold + 1 and len(word) >= 5 and len(cand) >= 5
                    and common_prefix_len(word, cand) >= 4):
                # 前缀共享型混淆（energy/emerge、complement/compliment）
                hits.append((d, _rank(row), cand, row["translation"]))
        hits.sort(key=lambda h: (h[0], h[1]))
        return hits

    hits = collect(2)
    if len(hits) < min_count:
        hits = collect(3)

    result, seen = [], set()
    for _, _, cand, trans in hits:
        if cand in seen:
            continue
        seen.add(cand)
        short = (trans or "").split("\n")[0][:40]
        result.append({"word": cand, "trans": short})
        if len(result) >= max_count:
            break
    return result


def suggest_similar(conn, word, count=3):
    """收录容错：词库查不到时给出拼写最接近的候选词（规划流程 A）。
    使用全量池（含生僻词），便于纠错。"""
    pool = _cached_pool(conn, max(1, len(word) - 2), len(word) + 2, False)
    scored = []
    for row in pool:
        d = dl_distance(word, row["word"], 3)
        if d <= 3:
            scored.append((d, _rank(row), row["word"], row["translation"]))
    scored.sort(key=lambda h: (h[0], h[1]))
    return [{"word": w, "trans": (t or "").split("\n")[0][:40]}
            for _, _, w, t in scored[:count]]
