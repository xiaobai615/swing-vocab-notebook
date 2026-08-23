"""统计面板与导出/恢复（规划 P5）。"""
import csv
import json
import os
from datetime import datetime

from . import db

EXPORT_DIR = os.path.join(db.BASE_DIR, "backup")


def overview(conn, today_start):
    counts = db.notebook_counts(conn)
    days = db.log_study_days(conn)
    streak = _streak(days)
    return {
        "total": sum(counts.values()),
        "new": counts.get("NEW", 0),
        "learning": counts.get("LEARNING", 0),
        "reviewing": counts.get("REVIEWING", 0),
        "mastered": counts.get("MASTERED", 0),
        "today_done": db.log_count_today(conn, today_start),
        "streak_days": streak,
        "weak": [(r["word"], r["fuzzy_count"]) for r in db.notebook_weak_words(conn, 10)],
    }


def _streak(days):
    """连续学习天数（从今天/昨天往前推）。"""
    if not days:
        return 0
    day_set = set(days)
    cur = datetime.now().date()
    if cur.strftime("%Y-%m-%d") not in day_set:
        from datetime import timedelta
        cur = cur - timedelta(days=1)
        if cur.strftime("%Y-%m-%d") not in day_set:
            return 0
    n = 0
    from datetime import timedelta
    while cur.strftime("%Y-%m-%d") in day_set:
        n += 1
        cur = cur - timedelta(days=1)
    return n


def export_json(conn, path=None):
    """导出 notebook + review_log 为带时间戳 JSON（规划 5.3）。"""
    os.makedirs(EXPORT_DIR, exist_ok=True)
    path = path or os.path.join(
        EXPORT_DIR, f"vocab_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json")
    data = {
        "version": 1,
        "exported_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "notebook": [dict(r) for r in db.notebook_all(conn)],
        "review_log": [dict(r) for r in conn.execute(
            "SELECT * FROM review_log ORDER BY id").fetchall()],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    return path


def import_json(conn, path):
    """从导出 JSON 完整恢复（先清空 notebook 与 review_log）。"""
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    conn.execute("DELETE FROM notebook")
    conn.execute("DELETE FROM review_log")
    for e in data["notebook"]:
        conn.execute(
            """INSERT INTO notebook (word, phonetic, translation, example, roots,
               confusables, status, repetition, interval_days, ef, next_review,
               added_at, last_reviewed, total_reviews, fuzzy_count)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (e["word"], e.get("phonetic"), e.get("translation"), e.get("example"),
             e.get("roots", "[]"), e.get("confusables", "[]"), e.get("status", "NEW"),
             e.get("repetition", 0), e.get("interval_days", 0), e.get("ef", 2.5),
             e.get("next_review"), e.get("added_at"), e.get("last_reviewed"),
             e.get("total_reviews", 0), e.get("fuzzy_count", 0)))
    for r in data["review_log"]:
        conn.execute(
            "INSERT INTO review_log (id, word, reviewed_at, grade, interval_after) VALUES (?,?,?,?,?)",
            (r.get("id"), r["word"], r.get("reviewed_at"), r.get("grade"),
             r.get("interval_after")))
    conn.commit()
    return len(data["notebook"])


def export_csv(conn, path=None):
    os.makedirs(EXPORT_DIR, exist_ok=True)
    path = path or os.path.join(
        EXPORT_DIR, f"vocab_export_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv")
    rows = db.notebook_all(conn)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(["word", "phonetic", "translation", "example", "status",
                    "interval_days", "next_review", "added_at"])
        for r in rows:
            w.writerow([r["word"], r["phonetic"], r["translation"], r["example"],
                        r["status"], r["interval_days"], r["next_review"],
                        r["added_at"]])
    return path
