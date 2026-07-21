#!/usr/bin/env python3
"""提取 PDF 文字。用法：python extract_text.py input.pdf [--pages 1-3] [--output text.txt]"""
import hashlib
import json
import os
import sys
from pathlib import Path
try: from pypdf import PdfReader
except ImportError: print("需要 pypdf。pip install pypdf"); sys.exit(1)

def cache_dir():
    configured = os.environ.get("OTTO_PDF_TEXT_CACHE_DIR")
    root = Path(configured) if configured else Path.home() / ".otto-user" / "cache" / "pdf-text"
    try:
        root.mkdir(parents=True, exist_ok=True)
        return root
    except OSError:
        return None

def cache_key(pdf_path, pages):
    st = pdf_path.stat()
    payload = {
        "path": str(pdf_path.resolve()),
        "size": st.st_size,
        "mtime_ns": st.st_mtime_ns,
        "pages": pages or "all",
    }
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()

def read_cache(key):
    root = cache_dir()
    if root is None:
        return None
    path = root / f"{key}.txt"
    try:
        if path.exists():
            return path.read_text(encoding="utf-8")
    except OSError:
        return None
    return None

def write_cache(key, text):
    root = cache_dir()
    if root is None:
        return
    path = root / f"{key}.txt"
    try:
        path.write_text(text, encoding="utf-8")
    except OSError:
        pass

def main():
    import argparse
    p = argparse.ArgumentParser(description="提取 PDF 文字")
    p.add_argument("input", help="输入 PDF"); p.add_argument("--pages", help="页码范围")
    p.add_argument("--output", "-o", help="输出文本文件")
    p.add_argument("--no-cache", action="store_true", help="跳过 Otto PDF 文本缓存")
    a = p.parse_args()
    pdf_path = Path(a.input)
    if not pdf_path.exists(): print(f"错误：找不到 {a.input}"); sys.exit(1)

    key = cache_key(pdf_path, a.pages)
    if not a.no_cache:
        cached = read_cache(key)
        if cached is not None:
            if a.output:
                Path(a.output).write_text(cached, encoding="utf-8")
                print(f"✅ 已从缓存读取：{a.output}（{len(cached)} 字）")
            else:
                print(cached)
            return

    print("Otto PDF 解析：缓存未命中，开始读取 PDF。", file=sys.stderr)
    reader = PdfReader(str(pdf_path)); total = len(reader.pages)

    if a.pages:
        parts = a.pages.split("-")
        start, end = int(parts[0]) - 1, (int(parts[1]) - 1 if len(parts) > 1 else int(parts[0]) - 1)
    else:
        start, end = 0, total - 1

    lines = []
    for i in range(start, min(end + 1, total)):
        text = reader.pages[i].extract_text() or ""
        lines.append(f"\n=== 第 {i+1} 页 ===\n{text}")
    result = "\n".join(lines)
    if not a.no_cache:
        write_cache(key, result)

    if a.output:
        Path(a.output).write_text(result, encoding="utf-8")
        print(f"✅ 已提取到：{a.output}（{end-start+1} 页, {len(result)} 字，已写入缓存）")
    else:
        print(result)

if __name__ == "__main__": main()
