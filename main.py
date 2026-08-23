#!/usr/bin/env python3
"""个人英语生词本 - CLI 入口（规划 8：python main.py 启动）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from vocab import cli

if __name__ == "__main__":
    cli.run()
