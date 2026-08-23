"""M2 单词收录模块 + M4 词条组装模块（规划流程 A）。

输入清洗 -> 去重检查 -> 词库查询 -> 组装词条 -> 形近词 -> 同根词 -> 入库。
"""
import re

from . import confusable, db, roots

_WORD_RE = re.compile(r"^[a-z]+([-'’][a-z]+)*$")


def clean_input(text):
    """清洗：去首尾空格、转小写、规范撇号。返回 (word, error)。"""
    if text is None:
        return None, "输入为空"
    w = text.strip().lower().replace("’", "'")
    if not w:
        return None, "输入为空"
    if not _WORD_RE.match(w):
        return None, "仅允许英文字母（可含连字符 - 与撇号 '）"
    return w, None


def collect(conn, text):
    """收录一个单词。

    返回 dict：
      ok=True  -> 已收录，含 entry
      ok=False, reason='invalid'   -> 非法输入
      ok=False, reason='duplicate' -> 已收录，含 existing
      ok=False, reason='not_found' -> 词库查不到，含 suggestions
    """
    word, err = clean_input(text)
    if err:
        return {"ok": False, "reason": "invalid", "message": err}

    existing = db.notebook_get(conn, word)
    if existing:
        return {"ok": False, "reason": "duplicate", "word": word,
                "existing": dict(existing)}

    row = db.dict_query(conn, word)
    if not row:
        return {"ok": False, "reason": "not_found", "word": word,
                "suggestions": confusable.suggest_similar(conn, word)}

    entry = {
        "word": word,
        "phonetic": row["phonetic"] or "",
        "translation": (row["translation"] or "").strip(),
        "example": (row["example"] or "").strip() if row["example"] else "",
        "roots": roots.find_roots(conn, word, row),
        "confusables": confusable.find_confusables(conn, word, row),
        "status": "NEW",
    }
    db.notebook_insert(conn, entry)
    return {"ok": True, "word": word, "entry": entry}
