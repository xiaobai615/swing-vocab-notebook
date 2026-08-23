#!/usr/bin/env python3
"""P0 数据准备：将 ECDICT (stardict.db) 导入 vocab.db 的 dictionary 表。

用法:
    python ingest.py [stardict.db 路径]

默认读取 data/stardict.db（来自 ecdict-sqlite-28.zip 解压）。
"""
import os
import sqlite3
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

from vocab import db  # noqa: E402


def ingest(stardict_path):
    conn = db.connect()
    db.init_db(conn)
    src = sqlite3.connect(stardict_path)
    src.row_factory = sqlite3.Row

    total = src.execute("SELECT COUNT(*) AS c FROM stardict").fetchone()["c"]
    print(f"ECDICT 源词条数: {total}")

    t0 = time.time()
    batch = []
    n = 0
    cur = src.execute(
        """SELECT word, phonetic, definition, translation, pos,
                  collins, oxford, tag, bnc, frq, exchange
           FROM stardict"""
    )
    conn.execute("DELETE FROM dictionary")
    for row in cur:
        word = (row["word"] or "").strip().lower()
        if not word:
            continue
        batch.append((
            word,
            (row["phonetic"] or "").strip(),
            (row["definition"] or "").strip(),
            (row["translation"] or "").strip(),
            "",  # example 由 examples 导入步骤补充
            (row["exchange"] or "").strip(),
            row["bnc"] or 0,
            row["frq"] or 0,
            row["collins"] or 0,
            (row["tag"] or "").strip(),
            len(word),
        ))
        n += 1
        if len(batch) >= 5000:
            conn.executemany(
                """INSERT OR REPLACE INTO dictionary
                   (word, phonetic, definition, translation, example,
                    exchange, bnc, frq, collins, tag, wlen)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""", batch)
            conn.commit()
            batch.clear()
            print(f"\r已导入 {n}/{total}", end="", flush=True)
    if batch:
        conn.executemany(
            """INSERT OR REPLACE INTO dictionary
               (word, phonetic, definition, translation, example,
                exchange, bnc, frq, collins, tag, wlen)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""", batch)
        conn.commit()
    src.close()
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    conn.close()
    print(f"\n导入完成: {n} 条，耗时 {time.time() - t0:.1f}s")
    print(f"数据库: {db.DB_PATH}")


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        BASE, "data", "stardict.db")
    if not os.path.exists(path):
        print(f"找不到词库文件: {path}")
        print("请先解压 ecdict-sqlite-28.zip，将 stardict.db 放到 data/ 目录")
        sys.exit(1)
    ingest(path)
