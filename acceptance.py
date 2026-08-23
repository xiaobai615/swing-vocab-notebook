#!/usr/bin/env python3
"""端到端验收脚本：在真实词库上逐条验证规划书 P1~P5 验收标准。

运行: python acceptance.py
"""
import os
import sys
import time
from datetime import datetime, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from vocab import collector, db, scheduler, stats  # noqa: E402

PASS = []
FAIL = []


def check(name, cond, extra=""):
    if cond:
        PASS.append(name)
        print(f"  [PASS] {name}")
    else:
        FAIL.append(name)
        print(f"  [FAIL] {name} {extra}")


def main():
    conn = db.connect()
    db.init_db(conn)

    print("=" * 60)
    print("P0 数据质量")
    print("=" * 60)
    total = db.dict_count(conn)
    check("词条数 >= 30 万", total >= 300000, f"(实际 {total})")
    t0 = time.time()
    for w in ("apple", "energy", "phenomenon", "emerge", "abandon"):
        r = db.dict_query(conn, w)
        check(f"常见词 {w} 四要素齐全",
              r and r["phonetic"] and r["translation"] and r["example"],
              f"phonetic={r['phonetic'] if r else '?'}, example={bool(r and r['example'])}")
    check("查询响应 < 50ms", (time.time() - t0) * 1000 / 5 < 50)
    spect = db.roots_for_word(conn, "inspect")
    check("词根表: spect 词族", {"prospect", "respect", "spectator"} <= set(spect),
          f"(实际 {spect})")

    print()
    print("=" * 60)
    print("P1 收录闭环")
    print("=" * 60)
    conn.execute("DELETE FROM notebook")
    conn.execute("DELETE FROM review_log")
    r = collector.collect(conn, "energy")
    check("收录 energy 成功且状态 NEW",
          r["ok"] and r["entry"]["status"] == "NEW")
    r2 = collector.collect(conn, " Energy ")
    check("重复/大小写归一化去重",
          not r2["ok"] and r2["reason"] == "duplicate")
    r3 = collector.collect(conn, "xyzqwe")
    check("不存在词给出候选", not r3["ok"] and r3["reason"] == "not_found"
          and isinstance(r3["suggestions"], list))
    r4 = collector.collect(conn, "energe")
    check("拼写纠错候选含 energy",
          not r4["ok"] and any(s["word"] == "energy" for s in r4["suggestions"]),
          f"(候选: {[s['word'] for s in r4['suggestions']][:5]})")

    print()
    print("=" * 60)
    print("P2 形近词")
    print("=" * 60)
    def get_entry(rr):
        return rr["entry"] if rr["ok"] else rr.get("existing")

    def parse_confusables(entry):
        c = entry["confusables"]
        return eval(c) if isinstance(c, str) else c

    for w in ("energy", "complement", "emergency"):
        rr = collector.collect(conn, w)
        entry = get_entry(rr)
        words = [c["word"] for c in parse_confusables(entry)]
        print(f"  {w} 的形近词: {words}")
    e = db.notebook_get(conn, "energy")
    conf = parse_confusables(e)
    check("energy 含 emerge/emergency", {"emerge", "emergency"} & {c["word"] for c in conf})
    c2 = db.notebook_get(conn, "complement")
    conf2 = parse_confusables(c2)
    check("complement 含 compliment", "compliment" in {c["word"] for c in conf2})
    check("形近词数量 3~6 个",
          all(3 <= len(parse_confusables(r)) <= 6 for r in db.notebook_all(conn)))
    # 复数排除
    check("形近词不含自身复数", "energies" not in {c["word"] for c in conf})

    print()
    print("=" * 60)
    print("P3 记忆调度")
    print("=" * 60)
    today = "2026-08-17"
    scheduler.apply_grade(conn, "energy", "know", today)
    row = db.notebook_get(conn, "energy")
    check("首知: interval=1, 次日复习, LEARNING",
          row["interval_days"] == 1 and row["next_review"] == "2026-08-18"
          and row["status"] == "LEARNING")
    # 模拟学习更多词并连续答对推进到 MASTERED
    for w in ("complement", "emergency", "emerge", "apple"):
        collector.collect(conn, w)
    queue = scheduler.build_daily_queue(conn, 20, today)
    check("今日队列 = 到期 + 新词", len(queue) >= 4)
    # 快速推进 energy 到掌握：手动重复 know
    upd = row
    for i in range(6):
        upd = scheduler.apply_grade(conn, "energy", "know", today)
    row = db.notebook_get(conn, "energy")
    check("间隔 >= 21 天且 know -> MASTERED",
          row["status"] == "MASTERED" and row["interval_days"] >= 21,
          f"(status={row['status']}, interval={row['interval_days']})")
    check("间隔封顶 180", row["interval_days"] <= 180)
    # 不认识重置
    scheduler.apply_grade(conn, "apple", "unknown", today)
    row = db.notebook_get(conn, "apple")
    check("不认识: rep=0, 次日复习", row["repetition"] == 0
          and row["next_review"] == "2026-08-18")
    # 模糊复现
    queue2 = [dict(r) for r in db.notebook_due(conn, today)]
    sess = scheduler.StudySession(queue2)
    w0 = sess.next_word()
    if w0 and w0["word"] != "energy":  # energy 已 MASTERED 不排队
        sess.submit_grade("fuzzy")
        gap = 0
        while True:
            w = sess.next_word()
            if w is None:
                break
            if w["word"] == w0["word"]:
                break
            gap += 1
        check("模糊词 3~5 词后复现", 3 <= gap <= 5, f"(gap={gap})")

    print()
    print("=" * 60)
    print("P5 统计与导出")
    print("=" * 60)
    ov = stats.overview(conn, f"{today} 00:00:00")
    check("统计各状态正确", ov["total"] == len(db.notebook_all(conn)))
    path = stats.export_json(conn)
    stats.import_json(conn, path)
    check("JSON 导出恢复无损",
          len(db.notebook_all(conn)) == ov["total"])
    path2 = stats.export_csv(conn)
    check("CSV 导出", os.path.exists(path2))

    print()
    print("=" * 60)
    print(f"结果: {len(PASS)} 通过, {len(FAIL)} 失败")
    if FAIL:
        print("失败项:", FAIL)
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
