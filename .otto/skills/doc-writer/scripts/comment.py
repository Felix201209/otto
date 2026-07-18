#!/usr/bin/env python3
"""
为 .docx 文档添加批注（Comment）。

工作流程：
  1. 解包 docx
  2. 运行本脚本创建批注 XML
  3. AI 编辑 document.xml 添加批注标记
  4. 重新打包

用法： python comment.py <work_dir> <comment_id> "<批注文字>"
      python comment.py <work_dir> <comment_id> "<回复文字>" --parent <parent_comment_id>
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from xml.etree import ElementTree as ET

# Windows 兼容：强制 UTF-8 输出
if sys.platform == 'win32':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass


def ns(ns_name: str) -> str:
    namespaces = {
        "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
        "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    }
    return namespaces.get(ns_name, "")


def ensure_comments_xml(work_dir: Path) -> Path:
    """确保 comments.xml 存在。"""
    word_dir = work_dir / "word"
    comments_path = word_dir / "comments.xml"

    if not comments_path.exists():
        ET.register_namespace("w", ns("w"))
        root = ET.Element(f"{{{ns('w')}}}comments")
        tree = ET.ElementTree(root)
        tree.write(str(comments_path), encoding="utf-8", xml_declaration=True)

    # 确保 Content_Types.xml 中有 comments 类型
    content_types_path = work_dir / "[Content_Types].xml"
    if content_types_path.exists():
        ct_content = content_types_path.read_text(encoding="utf-8")
        if "comments.xml" not in ct_content:
            ct_content = ct_content.replace(
                "</Types>",
                '<Override PartName="/word/comments.xml" '
                'ContentType="application/vnd.openxmlformats-officedocument'
                '.wordprocessingml.comments+xml"/>\n</Types>'
            )
            content_types_path.write_text(ct_content, encoding="utf-8")

    return comments_path


def add_comment(work_dir: str, comment_id: int, text: str, author: str = "Otto",
                parent: int | None = None):
    """添加批注。"""
    wd = Path(work_dir)
    comments_path = ensure_comments_xml(wd)

    ET.register_namespace("w", ns("w"))
    tree = ET.parse(str(comments_path))
    root = tree.getroot()

    now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
    uid = str(uuid.uuid4())

    # 创建 comment 元素
    comment = ET.SubElement(root, f"{{{ns('w')}}}comment")
    comment.set(f"{{{ns('w')}}}id", str(comment_id))
    comment.set(f"{{{ns('w')}}}author", author)
    comment.set(f"{{{ns('w')}}}date", now)
    if parent is not None:
        comment.set(f"{{{ns('w')}}}initials", f"reply-to-{parent}")

    # 批注内容段落
    p = ET.SubElement(comment, f"{{{ns('w')}}}p")
    r = ET.SubElement(p, f"{{{ns('w')}}}r")
    t = ET.SubElement(r, f"{{{ns('w')}}}t")
    t.text = text
    t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")

    tree.write(str(comments_path), encoding="utf-8", xml_declaration=True)

    print(f"✅ 批注已添加")
    print(f"   ID: {comment_id}")
    print(f"   作者: {author}")
    print(f"   内容: {text[:50]}{'...' if len(text) > 50 else ''}")
    if parent is not None:
        print(f"   回复: 批注 #{parent}")

    # 提示编辑 document.xml
    marker = f"""
📝 在 word/document.xml 中添加以下标记（插入到要批注的文本位置）：

<w:commentRangeStart w:id="{comment_id}"/>
<w:r><w:t>被批注的文本</w:t></w:r>
<w:commentRangeEnd w:id="{comment_id}"/>
<w:r>
  <w:rPr>
    <w:rStyle w:val="CommentReference"/>
  </w:rPr>
  <w:commentReference w:id="{comment_id}"/>
</w:r>
"""
    print(marker)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="为 .docx 添加批注")
    parser.add_argument("work_dir", help="解包后的工作目录")
    parser.add_argument("comment_id", type=int, help="批注 ID")
    parser.add_argument("text", help="批注文字（XML 已转义）")
    parser.add_argument("--author", default="Otto", help="批注作者（默认 Otto）")
    parser.add_argument("--parent", type=int, default=None, help="父批注 ID（回复用）")
    args = parser.parse_args()

    add_comment(args.work_dir, args.comment_id, args.text, args.author, args.parent)


if __name__ == "__main__":
    main()
