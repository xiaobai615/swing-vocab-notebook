"""M6 数据存储模块：SQLite 读写 + 备份导出。

业务层必须经本模块访问数据库，禁止跨层直连（规划 7.1）。
"""
import json
import os
import shutil
import sqlite3
from datetime import datetime

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
BACKUP_DIR = os.path.join(BASE_DIR, "backup")
DB_PATH = os.path.join(DATA_DIR, "vocab.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS dictionary (
    word TEXT PRIMARY KEY,
    phonetic TEXT,
    definition TEXT,
    translation TEXT,
    example TEXT,
    exchange TEXT,
    bnc INTEGER,
    frq INTEGER,
    collins INTEGER,
    tag TEXT,
    wlen INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dictionary_bnc ON dictionary(bnc);
CREATE INDEX IF NOT EXISTS idx_dict_wlen ON dictionary(wlen);

CREATE TABLE IF NOT EXISTS word_roots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root TEXT NOT NULL,
    word TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_word_roots_word ON word_roots(word);
CREATE INDEX IF NOT EXISTS idx_word_roots_root ON word_roots(root);

CREATE TABLE IF NOT EXISTS notebook (
    word TEXT PRIMARY KEY,
    phonetic TEXT,
    translation TEXT,
    example TEXT,
    roots TEXT DEFAULT '[]',
    confusables TEXT DEFAULT '[]',
    status TEXT DEFAULT 'NEW',
    repetition INTEGER DEFAULT 0,
    interval_days INTEGER DEFAULT 0,
    ef REAL DEFAULT 2.5,
    next_review TEXT,
    added_at TEXT,
    last_reviewed TEXT,
    total_reviews INTEGER DEFAULT 0,
    fuzzy_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS review_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    reviewed_at TEXT,
    grade TEXT,
    interval_after INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_log_word ON review_log(word);
"""


def connect(db_path=None):
    """返回一个启用外键与 Row 工厂的连接。支持 ":memory:" 用于测试。"""
    path = db_path or DB_PATH
    if path != ":memory:":
        os.makedirs(os.path.dirname(path), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(conn):
    conn.executescript(_SCHEMA)
    conn.commit()


# ---------- dictionary（只读词库） ----------

def dict_query(conn, word):
    return conn.execute(
        "SELECT * FROM dictionary WHERE word = ?", (word,)
    ).fetchone()


def dict_count(conn):
    return conn.execute("SELECT COUNT(*) AS c FROM dictionary").fetchone()["c"]


def dict_candidates_by_length(conn, min_len, max_len, common_only=True):
    """形近词候选池：长度窗口过滤（走 wlen 索引）；common_only=True 时
    仅保留常用词（有 bnc/frq 词频或柯林斯星级），剔除生僻拼写变体噪声。"""
    sql = ("SELECT word, translation, exchange, bnc, frq, collins FROM dictionary "
           "WHERE wlen BETWEEN ? AND ?")
    if common_only:
        sql += " AND (bnc > 0 OR frq > 0 OR collins > 0)"
    return conn.execute(sql, (min_len, max_len)).fetchall()


def dict_words_with_stem(conn, stem):
    """词形归并兜底：查询以词干开头或等于词干的词。"""
    return conn.execute(
        "SELECT word, translation, bnc, frq, collins FROM dictionary "
        "WHERE word = ? OR word LIKE ? LIMIT 60",
        (stem, stem + "%"),
    ).fetchall()


# ---------- word_roots ----------

def roots_for_word(conn, word):
    """查表法：返回与 word 同词根的词族列表。"""
    rows = conn.execute(
        """SELECT DISTINCT r2.word FROM word_roots r1
           JOIN word_roots r2 ON r1.root = r2.root
           WHERE r1.word = ? AND r2.word != ?""",
        (word, word),
    ).fetchall()
    return [r["word"] for r in rows]


def roots_table_size(conn):
    return conn.execute("SELECT COUNT(*) AS c FROM word_roots").fetchone()["c"]


# ---------- notebook ----------

def notebook_get(conn, word):
    return conn.execute("SELECT * FROM notebook WHERE word = ?", (word,)).fetchone()


def notebook_exists(conn, word):
    return notebook_get(conn, word) is not None


def notebook_insert(conn, entry):
    conn.execute(
        """INSERT INTO notebook
           (word, phonetic, translation, example, roots, confusables,
            status, repetition, interval_days, ef, next_review,
            added_at, last_reviewed, total_reviews, fuzzy_count)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            entry["word"], entry.get("phonetic"), entry.get("translation"),
            entry.get("example"), json.dumps(entry.get("roots", []), ensure_ascii=False),
            json.dumps(entry.get("confusables", []), ensure_ascii=False),
            entry.get("status", "NEW"), entry.get("repetition", 0),
            entry.get("interval_days", 0), entry.get("ef", 2.5),
            entry.get("next_review"), entry.get("added_at") or _now(),
            entry.get("last_reviewed"), entry.get("total_reviews", 0),
            entry.get("fuzzy_count", 0),
        ),
    )
    conn.commit()


def notebook_update_progress(conn, word, status, repetition, interval_days, ef,
                             next_review, fuzzy_count_delta=0):
    conn.execute(
        """UPDATE notebook SET status=?, repetition=?, interval_days=?, ef=?,
           next_review=?, last_reviewed=?, total_reviews=total_reviews+1,
           fuzzy_count=fuzzy_count+?
           WHERE word=?""",
        (status, repetition, interval_days, ef, next_review, _now(),
         fuzzy_count_delta, word),
    )
    conn.commit()


def notebook_due(conn, today):
    """到期复习词：next_review <= today，按到期日升序。"""
    return conn.execute(
        """SELECT * FROM notebook WHERE next_review IS NOT NULL
           AND next_review <= ? AND status != 'MASTERED'
           ORDER BY next_review ASC""",
        (today,),
    ).fetchall()


def notebook_new_words(conn, limit):
    return conn.execute(
        "SELECT * FROM notebook WHERE status='NEW' ORDER BY added_at ASC LIMIT ?",
        (limit,),
    ).fetchall()


def notebook_all(conn, status=None):
    if status:
        return conn.execute(
            "SELECT * FROM notebook WHERE status=? ORDER BY added_at DESC", (status,)
        ).fetchall()
    return conn.execute("SELECT * FROM notebook ORDER BY added_at DESC").fetchall()


def notebook_counts(conn):
    rows = conn.execute(
        "SELECT status, COUNT(*) AS c FROM notebook GROUP BY status"
    ).fetchall()
    return {r["status"]: r["c"] for r in rows}


def notebook_weak_words(conn, limit=10):
    return conn.execute(
        """SELECT * FROM notebook WHERE fuzzy_count > 0
           ORDER BY fuzzy_count DESC, total_reviews DESC LIMIT ?""",
        (limit,),
    ).fetchall()


def notebook_delete(conn, word):
    conn.execute("DELETE FROM notebook WHERE word=?", (word,))
    conn.commit()


# ---------- review_log ----------

def log_review(conn, word, grade, interval_after, when=None):
    conn.execute(
        "INSERT INTO review_log (word, reviewed_at, grade, interval_after) VALUES (?,?,?,?)",
        (word, when or _now(), grade, interval_after),
    )
    conn.commit()


def log_count_today(conn, today_start):
    return conn.execute(
        "SELECT COUNT(*) AS c FROM review_log WHERE reviewed_at >= ?", (today_start,)
    ).fetchone()["c"]


def log_study_days(conn):
    rows = conn.execute(
        "SELECT DISTINCT substr(reviewed_at, 1, 10) AS d FROM review_log ORDER BY d DESC"
    ).fetchall()
    return [r["d"] for r in rows]


# ---------- 备份 ----------

def backup_db(conn):
    """程序退出时保留最近 7 天的数据库副本（规划 7.1）。"""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    conn.commit()
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = os.path.join(BACKUP_DIR, f"vocab_{stamp}.db")
    src = conn.execute("PRAGMA database_list").fetchone()["file"]
    conn.close()
    shutil.copyfile(src, dst)
    # 清理 7 天前的副本
    now = datetime.now().timestamp()
    for f in os.listdir(BACKUP_DIR):
        p = os.path.join(BACKUP_DIR, f)
        if f.startswith("vocab_") and now - os.path.getmtime(p) > 7 * 86400:
            os.remove(p)
    return dst


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")
