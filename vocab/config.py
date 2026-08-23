"""配置项（规划 P5）：每日新词配额、日界时刻、形近词数量上限。"""
import json
import os

from . import db

CONFIG_PATH = os.path.join(db.BASE_DIR, "config.json")

DEFAULTS = {
    "new_quota": 20,          # 每日新词配额（5~100）
    "day_boundary_hour": 4,   # 日界时刻（凌晨几点算新的一天）
    "confusable_max": 6,      # 形近词展示上限
    "confusable_min": 3,      # 形近词下限（不足则放宽编辑距离）
}


def load():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except (json.JSONDecodeError, OSError):
            pass
    return cfg


def save(cfg):
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
