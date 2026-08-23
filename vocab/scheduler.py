"""M3 学习/复习调度模块（规划第四章）。

状态机：NEW -> LEARNING -> REVIEWING -> MASTERED
三档自评：know（认识）/ fuzzy（模糊）/ unknown（不认识）
间隔公式（SM-2 简化变体）：
  know:    rep+=1; interval = rep==1 ? 1 : (rep==2 ? 3 : round(interval*ef)); ef+=0.05(<=2.8)
  fuzzy:   rep 不变; interval = max(1, round(interval*0.5)); ef-=0.15
  unknown: rep=0; interval=0; ef-=0.2; 次日复习; 会话内复现直至 know
ef 下限 1.3；interval 封顶 180 天；interval>=21 且当次 know -> MASTERED。
"""
import random
from datetime import datetime, timedelta

from . import db

EF_INIT = 2.5
EF_MIN = 1.3
EF_MAX = 2.8
INTERVAL_MAX = 180
MASTERY_INTERVAL = 21

GRADE_KNOW = "know"
GRADE_FUZZY = "fuzzy"
GRADE_UNKNOWN = "unknown"


def today_str(day_boundary_hour=4, now=None):
    """学习日：凌晨 day_boundary_hour 点为日界（规划 4.5）。"""
    now = now or datetime.now()
    if now.hour < day_boundary_hour:
        now = now - timedelta(days=1)
    return now.strftime("%Y-%m-%d")


def grade_word(row, grade, today=None):
    """对一条 notebook 记录应用三档自评，返回更新后的字段 dict（纯函数，可测试）。"""
    today = today or today_str()
    rep = row["repetition"]
    interval = row["interval_days"]
    ef = row["ef"] or EF_INIT
    status = row["status"]

    if grade == GRADE_KNOW:
        rep += 1
        if rep == 1:
            interval = 1
        elif rep == 2:
            interval = 3
        else:
            interval = round(interval * ef)
        ef = min(EF_MAX, ef + 0.05)
        fuzzy_delta = 0
    elif grade == GRADE_FUZZY:
        interval = max(1, round(interval * 0.5)) if interval > 0 else 1
        ef = max(EF_MIN, ef - 0.15)
        fuzzy_delta = 1
    elif grade == GRADE_UNKNOWN:
        rep = 0
        interval = 0
        ef = max(EF_MIN, ef - 0.20)
        fuzzy_delta = 0
    else:
        raise ValueError(f"非法自评档位: {grade}")

    interval = min(INTERVAL_MAX, interval)

    # 状态机推进
    if status == "NEW":
        status = "LEARNING"
    if grade == GRADE_KNOW:
        if status == "LEARNING" and rep >= 2:
            status = "REVIEWING"
        if interval >= MASTERY_INTERVAL:
            status = "MASTERED"
    elif grade == GRADE_UNKNOWN and status == "MASTERED":
        status = "REVIEWING"

    if grade == GRADE_UNKNOWN:
        next_review = (datetime.strptime(today, "%Y-%m-%d")
                       + timedelta(days=1)).strftime("%Y-%m-%d")
    else:
        next_review = (datetime.strptime(today, "%Y-%m-%d")
                       + timedelta(days=interval)).strftime("%Y-%m-%d")

    return {
        "status": status, "repetition": rep, "interval_days": interval,
        "ef": round(ef, 2), "next_review": next_review,
        "fuzzy_delta": fuzzy_delta,
    }


def apply_grade(conn, word, grade, today=None):
    """读取 -> 计算 -> 落库 -> 写日志。"""
    row = db.notebook_get(conn, word)
    if not row:
        raise KeyError(f"生词本中不存在: {word}")
    today = today or today_str()
    upd = grade_word(row, grade, today)
    db.notebook_update_progress(
        conn, word, upd["status"], upd["repetition"], upd["interval_days"],
        upd["ef"], upd["next_review"], upd["fuzzy_delta"])
    db.log_review(conn, word, grade, upd["interval_days"])
    return upd


def build_daily_queue(conn, new_quota=20, today=None):
    """今日任务 = 到期复习词（全部，不设上限）+ 新词配额（规划 4.3）。"""
    today = today or today_str()
    due = [dict(r) for r in db.notebook_due(conn, today)]
    new = [dict(r) for r in db.notebook_new_words(conn, new_quota)]
    return due + new


class StudySession:
    """学习会话：主队列 + 会话内复现队列（规划 4.4）。

    - 模糊/不认识的词进入复现队列，隔 3~5 个词后再次出词；
    - unknown 必须复现到 know 为止；fuzzy 复现一次即可。
    """

    def __init__(self, queue):
        self._main = list(queue)
        self._pending = {}   # word -> {"row":..., "due_at":int, "kind":str}
        self._served = 0     # 已出主队列词数（用于计算复现间隔）
        self._requeue_counts = {}
        self.results = {"know": 0, "fuzzy": 0, "unknown": 0}
        self.current = None

    def next_word(self):
        """返回下一个要出的词（dict），没有则 None。"""
        # 先看是否有到期的复现词
        for w, item in list(self._pending.items()):
            if self._served >= item["due_at"]:
                del self._pending[w]
                self.current = item["row"]
                return self.current
        if self._main:
            self.current = self._main.pop(0)
            self._served += 1
            return self.current
        # 主队列空了但还有复现词：立即出
        if self._pending:
            w, item = self._pending.popitem()
            self.current = item["row"]
            return self.current
        self.current = None
        return None

    def submit_grade(self, grade):
        """提交自评，返回是否需要复现。"""
        if self.current is None:
            raise RuntimeError("当前没有出词")
        self.results[grade] += 1
        word = self.current["word"]
        count = self._requeue_counts.get(word, 0)
        if grade == GRADE_UNKNOWN:
            # 必须复现到 know 为止
            self._pending[word] = {
                "row": dict(self.current),
                "due_at": self._served + random.randint(3, 5),
                "kind": "unknown",
            }
            self._requeue_counts[word] = count + 1
            return True
        if grade == GRADE_FUZZY and count == 0:
            # 模糊只复现一次
            self._pending[word] = {
                "row": dict(self.current),
                "due_at": self._served + random.randint(3, 5),
                "kind": "fuzzy",
            }
            self._requeue_counts[word] = count + 1
            return True
        return False

    def remaining(self):
        return len(self._main) + len(self._pending)
