"""M1 交互界面模块（规划 P4）：CLI 菜单与学习/复习界面。"""
import json
import os
import re
import sys
import time
from datetime import datetime

from . import collector, config, db, scheduler, stats


def _print_word_card(row, show_answer):
    """出词卡片：先只显示英文 + 音标；翻答案后显示全部要素。"""
    print("\n" + "=" * 56)
    word = row["word"]
    phonetic = row["phonetic"] or ""
    if phonetic:
        # phonetic 已含 /.../ 时不再重复包裹
        phonetic = phonetic if phonetic.startswith("/") else f"/{phonetic}/"
    print(f"  【{word}】  {phonetic}")
    if show_answer:
        print("-" * 56)
        trans = (row["translation"] or "").strip()
        print("  词义:")
        for line in trans.split("\n"):
            if line.strip():
                print(f"    {line.strip()}")
        example = (row["example"] or "").strip()
        print("  例句:")
        print(f"    {example if example else '暂无例句'}")
        roots = row["roots"]
        if isinstance(roots, str):
            roots = json.loads(roots or "[]")
        # 过滤含空格的短语条目（如 "compleat angler"），只保留纯单词
        roots = [r for r in roots if re.fullmatch(r"[a-z]+", r)]
        print("  同根词:")
        print(f"    {', '.join(roots) if roots else '暂无同根词'}")
        confus = row["confusables"]
        if isinstance(confus, str):
            confus = json.loads(confus or "[]")
        print("  易混淆:")
        if confus:
            for c in confus:
                print(f"    {c['word']:<16} {c['trans']}")
        else:
            print("    暂无形近词")
    print("=" * 56)


def _study_flow(conn, queue, cfg):
    """出词 -> 回忆 -> 翻答案 -> 自评 的会话流程。"""
    sess = scheduler.StudySession(queue)
    total = len(queue)
    done = 0
    while True:
        row = sess.next_word()
        if row is None:
            break
        done += 1
        print(f"\n[进度 {done}/{total} | 剩余 {sess.remaining()}]")
        _print_word_card(row, show_answer=False)
        input("  （心中回忆词义，按回车翻开答案...）")
        _print_word_card(row, show_answer=True)
        while True:
            g = input("  自评 [1]认识 [2]模糊 [3]不认识 [q]提前结束: ").strip().lower()
            if g == "q":
                print("  已提前结束，进度已保存。")
                return sess
            if g in ("1", "2", "3"):
                break
            print("  请输入 1 / 2 / 3 / q")
        grade = {"1": "know", "2": "fuzzy", "3": "unknown"}[g]
        today = scheduler.today_str(cfg["day_boundary_hour"])
        upd = scheduler.apply_grade(conn, row["word"], grade, today)
        need_re = sess.submit_grade(grade)
        hint = {"know": f"下次复习: {upd['next_review']}（间隔 {upd['interval_days']} 天）",
                "fuzzy": "已记录为模糊，稍后复现一次",
                "unknown": "已记录为不认识，稍后会再次出现直到答对"}[grade]
        print(f"  -> {hint}")
        if need_re:
            pass  # 复现由 session 自动调度
    _print_session_summary(sess)
    return sess


def _print_session_summary(sess):
    r = sess.results
    print("\n" + "-" * 56)
    print(f"  本次学习完成！认识 {r['know']} | 模糊 {r['fuzzy']} | 不认识 {r['unknown']}")
    print("-" * 56)


def _menu_add(conn):
    text = input("请输入要收录的英文单词: ")
    result = collector.collect(conn, text)
    if result["ok"]:
        e = result["entry"]
        print(f"已收录 [{e['word']}] /{e['phonetic']}/")
        print(f"  词义: {(e['translation'] or '').splitlines()[0] if e['translation'] else ''}")
        print(f"  同根词: {', '.join(e['roots']) if e['roots'] else '暂无'}")
        print(f"  易混淆: {', '.join(c['word'] for c in e['confusables']) if e['confusables'] else '暂无'}")
        counts = db.notebook_counts(conn)
        print(f"  当前待学习新词: {counts.get('NEW', 0)} 个")
    elif result["reason"] == "invalid":
        print(f"输入无效：{result['message']}")
    elif result["reason"] == "duplicate":
        ex = result["existing"]
        print(f"[{result['word']}] 已在生词本中，当前状态: {ex['status']}，"
              f"下次复习: {ex['next_review'] or '未安排'}")
    elif result["reason"] == "not_found":
        print(f"词库中未找到 [{result['word']}]。你是不是想输入：")
        for i, s in enumerate(result["suggestions"], 1):
            print(f"  {i}. {s['word']}  {s['trans']}")
        choice = input("选择编号直接收录（回车跳过）: ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(result["suggestions"]):
            _menu_add_word(conn, result["suggestions"][int(choice) - 1]["word"])


def _menu_add_word(conn, word):
    result = collector.collect(conn, word)
    if result["ok"]:
        print(f"已收录 [{word}]")


def _menu_study(conn, cfg, only_new=False):
    today = scheduler.today_str(cfg["day_boundary_hour"])
    if only_new:
        queue = [dict(r) for r in db.notebook_new_words(conn, cfg["new_quota"])]
    else:
        queue = scheduler.build_daily_queue(conn, cfg["new_quota"], today)
    if not queue:
        print("今日没有任务。可先添加生词，或明天再来复习。")
        return
    due_n = len([r for r in queue if r["status"] != "NEW"])
    if due_n > 200:
        print(f"提示：今日到期复习词较多（{due_n} 个），建议分批完成。")
    print(f"今日任务共 {len(queue)} 个（复习 {due_n} + 新词 {len(queue) - due_n}）")
    _study_flow(conn, queue, cfg)


def _menu_browse(conn):
    """查看生词本：分页列表 + 选中单词查看完整词条卡片。"""
    rows = db.notebook_all(conn)
    if not rows:
        print("生词本为空。")
        return
    page_size = 20
    total = len(rows)
    pages = (total + page_size - 1) // page_size
    page = 0
    while True:
        print(f"\n共 {total} 个单词（第 {page + 1}/{pages} 页，输入编号查看详情）:")
        start = page * page_size
        for idx, r in enumerate(rows[start:start + page_size], start + 1):
            trans = (r["translation"] or "").splitlines()
            trans = trans[0].strip() if trans else ""
            if len(trans) > 18:
                trans = trans[:17] + "…"
            print(f"  {idx:>3}. {r['word']:<16} [{r['status']:<9}] "
                  f"间隔{r['interval_days']:>3}天 下次:{r['next_review'] or '-':<10} "
                  f"{trans}")
        print("  " + ("n. 下一页  p. 上一页  " if pages > 1 else "")
              + "q. 返回主菜单")
        choice = input("选择编号/指令: ").strip().lower()
        if choice == "q":
            return
        if choice == "n" and page < pages - 1:
            page += 1
        elif choice == "p" and page > 0:
            page -= 1
        elif choice.isdigit():
            num = int(choice)
            if 1 <= num <= total:
                _print_word_card(rows[num - 1], show_answer=True)
                input("\n按回车返回列表...")
            else:
                print("  编号超出范围。")
        else:
            print("  无效输入。")


def _menu_stats(conn, cfg):
    today = scheduler.today_str(cfg["day_boundary_hour"])
    ov = stats.overview(conn, f"{today} 00:00:00")
    print("\n===== 学习统计 =====")
    print(f"  生词总数: {ov['total']}")
    print(f"  待学习 NEW: {ov['new']} | 学习中: {ov['learning']} | "
          f"复习中: {ov['reviewing']} | 已掌握: {ov['mastered']}")
    print(f"  今日已完成: {ov['today_done']} 次出词 | 连续学习: {ov['streak_days']} 天")
    if ov["weak"]:
        print("  薄弱词 Top10（按模糊次数）:")
        for w, c in ov["weak"]:
            print(f"    {w}  模糊 {c} 次")


def _menu_export(conn):
    p1 = stats.export_json(conn)
    p2 = stats.export_csv(conn)
    print(f"已导出:\n  JSON: {p1}\n  CSV:  {p2}")


def _menu_bulk_import(conn):
    """批量导入生词：文本文件（每行一词，# 注释）或直接粘贴多词。"""
    print("\n批量导入生词")
    print("  文件格式：每行一个单词，# 开头为注释行，空行自动跳过")
    print("  粘贴格式：空格 / 逗号 / 换行分隔均可")
    mode = input("选择：1. 从文件导入  2. 直接粘贴  0. 取消: ").strip()
    if mode == "1":
        path = input("文件路径: ").strip().strip('"')
        if not os.path.exists(path):
            print(f"  文件不存在: {path}")
            return
        words = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                w = line.strip()
                if not w or w.startswith("#"):
                    continue
                words.append(w)
    elif mode == "2":
        text = input("粘贴单词（用空格/逗号/换行分隔）:\n").strip()
        words = [w for w in re.split(r"[\s,，;；]+", text) if w]
    else:
        return
    if not words:
        print("  未解析到任何单词。")
        return

    # 批内去重 + 输入清洗
    seen, uniq = set(), []
    for w in words:
        cw, err = collector.clean_input(w)
        if cw and cw not in seen:
            seen.add(cw)
            uniq.append(cw)
    print(f"解析到 {len(words)} 个词条，去重后 {len(uniq)} 个，开始导入...")

    ok, dup, miss = [], [], []
    t0 = time.time()
    for i, w in enumerate(uniq, 1):
        r = collector.collect(conn, w)
        if r["ok"]:
            ok.append(w)
        elif r["reason"] == "duplicate":
            dup.append(w)
        else:
            miss.append((w, r.get("suggestions", [])))
        print(f"\r  进度 {i}/{len(uniq)}（成功 {len(ok)}）", end="", flush=True)
    print(f"\n耗时 {time.time() - t0:.1f}s")
    print("=" * 40)
    print(f"新收录 {len(ok)} | 已在生词本 {len(dup)} | 未找到 {len(miss)}")
    if ok:
        print("  新收录:", ", ".join(ok))
    if dup:
        print("  已存在:", ", ".join(dup))
    if miss:
        print("  未找到的词（可考虑候选）:")
        for w, sugg in miss:
            cand = "、".join(s["word"] for s in sugg[:3]) or "无候选"
            print(f"    {w}  ->  候选: {cand}")


def _menu_config(cfg):
    print(f"当前配置: 每日新词 {cfg['new_quota']} | 日界 {cfg['day_boundary_hour']} 点 | "
          f"形近词 {cfg['confusable_min']}~{cfg['confusable_max']} 个")
    v = input("修改每日新词配额（5~100，回车不变）: ").strip()
    if v.isdigit() and 5 <= int(v) <= 100:
        cfg["new_quota"] = int(v)
    v = input("修改日界时刻（0~23，回车不变）: ").strip()
    if v.isdigit() and 0 <= int(v) <= 23:
        cfg["day_boundary_hour"] = int(v)
    config.save(cfg)
    print("配置已保存。")


MENU = """
========== 英语生词本 ==========
  1. 添加生词
  2. 今日学习（复习 + 新词）
  3. 只学新词
  4. 查看生词本
  5. 学习统计
  6. 导出备份
  7. 设置
  8. 批量导入生词
  0. 退出
================================"""


def run():
    conn = db.connect()
    db.init_db(conn)
    cfg = config.load()
    if db.dict_count(conn) == 0:
        print("警告：内置词库为空，请先运行: python ingest.py")
    try:
        while True:
            print(MENU)
            choice = input("请选择: ").strip()
            if choice == "1":
                _menu_add(conn)
            elif choice == "2":
                _menu_study(conn, cfg)
            elif choice == "3":
                _menu_study(conn, cfg, only_new=True)
            elif choice == "4":
                _menu_browse(conn)
            elif choice == "5":
                _menu_stats(conn, cfg)
            elif choice == "6":
                _menu_export(conn)
            elif choice == "7":
                _menu_config(cfg)
            elif choice == "8":
                _menu_bulk_import(conn)
            elif choice == "0":
                break
            else:
                print("无效选择。")
    except (EOFError, KeyboardInterrupt):
        print("\n已中断，进度已保存。")
    finally:
        try:
            path = db.backup_db(conn)
            print(f"数据库已自动备份: {path}")
        except Exception:
            conn.close()
    sys.exit(0)
