"""P3 验收：调度核心自动化测试（规划 P3 验收标准逐条对应）。"""
import os
import sys
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from vocab import db, scheduler  # noqa: E402


def make_row(status="NEW", rep=0, interval=0, ef=2.5):
    return {"word": "test", "status": status, "repetition": rep,
            "interval_days": interval, "ef": ef}


class TestGradeWord(unittest.TestCase):
    TODAY = "2026-08-17"

    def test_new_first_know(self):
        """新词首次"认识": interval=1, 次日复习, 状态 LEARNING"""
        upd = scheduler.grade_word(make_row(), "know", self.TODAY)
        self.assertEqual(upd["interval_days"], 1)
        self.assertEqual(upd["status"], "LEARNING")
        self.assertEqual(upd["next_review"], "2026-08-18")

    def test_second_know_to_reviewing(self):
        """连续两次"认识": 第二次 interval=3, 状态 REVIEWING"""
        upd = scheduler.grade_word(make_row("LEARNING", 1, 1), "know", self.TODAY)
        self.assertEqual(upd["interval_days"], 3)
        self.assertEqual(upd["status"], "REVIEWING")
        self.assertEqual(upd["next_review"], "2026-08-20")

    def test_unknown_resets(self):
        """"不认识": rep 清零, 次日复习"""
        upd = scheduler.grade_word(make_row("REVIEWING", 4, 10), "unknown", self.TODAY)
        self.assertEqual(upd["repetition"], 0)
        self.assertEqual(upd["interval_days"], 0)
        self.assertEqual(upd["next_review"], "2026-08-18")

    def test_fuzzy_halves_interval(self):
        """"模糊": rep 不变, interval 减半, ef 下调"""
        upd = scheduler.grade_word(make_row("REVIEWING", 3, 8, 2.5), "fuzzy", self.TODAY)
        self.assertEqual(upd["repetition"], 3)
        self.assertEqual(upd["interval_days"], 4)
        self.assertAlmostEqual(upd["ef"], 2.35)

    def test_mastery_at_21_days(self):
        """interval >= 21 且当次"认识" -> MASTERED"""
        upd = scheduler.grade_word(make_row("REVIEWING", 6, 15, 2.5), "know", self.TODAY)
        # 15 * 2.5 = 37.5 -> 38 >= 21
        self.assertEqual(upd["status"], "MASTERED")
        self.assertGreaterEqual(upd["interval_days"], 21)

    def test_interval_cap_180(self):
        upd = scheduler.grade_word(make_row("REVIEWING", 10, 150, 2.8), "know", self.TODAY)
        self.assertEqual(upd["interval_days"], 180)

    def test_ef_floor(self):
        upd = scheduler.grade_word(make_row("REVIEWING", 0, 0, 1.3), "unknown", self.TODAY)
        self.assertEqual(upd["ef"], 1.3)


class TestSession(unittest.TestCase):
    def test_unknown_requeue_until_know(self):
        """"不认识"进入复现队列, 复现间隔 3~5 词"""
        queue = [{"word": f"w{i}", "status": "NEW", "repetition": 0,
                  "interval_days": 0, "ef": 2.5} for i in range(10)]
        sess = scheduler.StudySession(queue)
        seen = []
        # 第一个词答不认识
        row = sess.next_word()
        self.assertEqual(row["word"], "w0")
        self.assertTrue(sess.submit_grade("unknown"))
        # 接下来 3~5 个词内必须再次出现 w0
        for _ in range(6):
            row = sess.next_word()
            if row is None:
                break
            seen.append(row["word"])
            if row["word"] == "w0":
                break
        self.assertIn("w0", seen)
        idx = seen.index("w0")  # idx 即中间间隔的词数
        self.assertTrue(3 <= idx <= 5, f"复现间隔应为 3~5 个词, 实际 {idx}")

    def test_fuzzy_requeue_once(self):
        queue = [{"word": f"w{i}", "status": "NEW", "repetition": 0,
                  "interval_days": 0, "ef": 2.5} for i in range(10)]
        sess = scheduler.StudySession(queue)
        row = sess.next_word()
        self.assertTrue(sess.submit_grade("fuzzy"))   # 第一次模糊: 复现
        # 快进到复现
        target = None
        for _ in range(12):
            row = sess.next_word()
            if row and row["word"] == "w0":
                target = row
                break
        self.assertIsNotNone(target)
        # 复现时仍模糊: 不再复现
        self.assertFalse(sess.submit_grade("fuzzy"))

    def test_session_drains(self):
        """主队列空后复现词仍会出完"""
        queue = [{"word": "a", "status": "NEW", "repetition": 0,
                  "interval_days": 0, "ef": 2.5}]
        sess = scheduler.StudySession(queue)
        sess.next_word()
        sess.submit_grade("unknown")
        row = sess.next_word()   # 主队列已空, 应出复现词
        self.assertIsNotNone(row)
        self.assertEqual(row["word"], "a")
        sess.submit_grade("know")
        self.assertIsNone(sess.next_word())


class TestDayBoundary(unittest.TestCase):
    def test_boundary_4am(self):
        """凌晨 4 点前算前一天（规划 4.5）"""
        now = datetime(2026, 8, 17, 2, 30)
        self.assertEqual(scheduler.today_str(4, now), "2026-08-16")
        now2 = datetime(2026, 8, 17, 5, 0)
        self.assertEqual(scheduler.today_str(4, now2), "2026-08-17")


class TestDailyQueue(unittest.TestCase):
    def setUp(self):
        self.conn = db.connect(":memory:")
        db.init_db(self.conn)

    def tearDown(self):
        self.conn.close()

    def _add(self, word, status="NEW", next_review=None, interval=0, rep=0):
        db.notebook_insert(self.conn, {
            "word": word, "status": status, "next_review": next_review,
            "interval_days": interval, "repetition": rep})

    def test_due_first_then_new(self):
        """到期复习词优先, 新词按配额"""
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        tomorrow = (datetime.now() + timedelta(days=1)).strftime("%Y-%m-%d")
        self._add("due1", "REVIEWING", yesterday, 3, 2)
        self._add("due2", "REVIEWING", scheduler.today_str(), 1, 1)
        self._add("future", "REVIEWING", tomorrow, 5, 3)
        for i in range(25):
            self._add(f"new{i:02d}")
        queue = scheduler.build_daily_queue(self.conn, new_quota=20)
        words = [r["word"] for r in queue]
        self.assertEqual(words[:2], ["due1", "due2"])  # 到期日升序
        self.assertNotIn("future", words)
        self.assertEqual(len(queue), 22)  # 2 复习 + 20 新词

    def test_mastered_not_queued(self):
        self._add("m", "MASTERED", "2020-01-01", 30, 8)
        queue = scheduler.build_daily_queue(self.conn)
        self.assertEqual([r["word"] for r in queue], [])


if __name__ == "__main__":
    unittest.main()
