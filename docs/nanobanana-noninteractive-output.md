# NanoBanana 非交互模式输出格式

## 概述

在非交互模式（`--output-format stream-json`）下，`/nanobanana` 命令会输出详细的流式进度信息，方便脚本化处理和监控。

## 输出流

- **stdout**：标准的 Otto JSON 消息（`type: "message"`, `type: "result"` 等）
- **stderr**：NanoBanana 特定的详细进度事件（JSON 格式）

## 事件类型

### 1. `nanobanana_upload_start` - 开始上传参考图

仅在使用参考图时输出。

```json
{
  "type": "nanobanana_upload_start",
  "timestamp": "2026-02-14T08:00:00.000Z",
  "reference_image": "path/to/image.jpg"
}
```

**字段说明**：
- `type`: 固定为 `nanobanana_upload_start`
- `timestamp`: ISO 8601 格式的时间戳
- `reference_image`: 本地参考图片路径

---

### 2. `nanobanana_upload_success` - 参考图上传成功

```json
{
  "type": "nanobanana_upload_success",
  "timestamp": "2026-02-14T08:00:01.000Z",
  "reference_image": "path/to/image.jpg",
  "uploaded_url": "https://cdn.example.com/user-abc123.jpg"
}
```

**字段说明**：
- `uploaded_url`: 上传后的 CDN URL，用于生成任务

---

### 3. `nanobanana_upload_failed` - 参考图上传失败

```json
{
  "type": "nanobanana_upload_failed",
  "timestamp": "2026-02-14T08:00:01.000Z",
  "reference_image": "path/to/image.jpg",
  "error": "Image file not found: path/to/image.jpg"
}
```

**字段说明**：
- `error`: 错误消息

---

### 4. `nanobanana_submitted` - 任务提交成功

```json
{
  "type": "nanobanana_submitted",
  "timestamp": "2026-02-14T08:00:02.000Z",
  "task_id": "task_abc123xyz",
  "prompt": "一个可爱的小猫照片",
  "ratio": "auto",
  "size": "1k",
  "reference_image": null,
  "reference_image_url": null,
  "estimated_time_seconds": 60,
  "credits_estimated": 10
}
```

**字段说明**：
- `task_id`: 任务唯一标识符
- `prompt`: 生成提示词
- `ratio`: 图片比例（`auto`, `1:1`, `16:9`, `9:16`, `4:3`, `3:4` 等）
- `size`: 图片大小（`auto`, `1K`, `2K`）
- `reference_image`: 本地参考图路径（如果有）
- `reference_image_url`: 上传后的参考图 URL（如果有）
- `estimated_time_seconds`: 预估完成时间（秒）
- `credits_estimated`: 预估消耗积分

---

### 5. `nanobanana_progress` - 生成进度更新

每 2 秒输出一次，直到任务完成或失败。

```json
{
  "type": "nanobanana_progress",
  "timestamp": "2026-02-14T08:00:04.000Z",
  "task_id": "task_abc123xyz",
  "status": "processing",
  "elapsed_seconds": 4,
  "estimated_seconds": 60,
  "progress_percent": 6
}
```

**字段说明**：
- `status`: 任务状态
  - `pending`: 等待中
  - `processing`: 生成中
- `elapsed_seconds`: 已经过时间（秒）
- `estimated_seconds`: 预估总时间（秒）
- `progress_percent`: 虚拟进度百分比（0-95），基于 `elapsed / estimated * 100` 计算

**进度计算逻辑**：
- 进度 = min(95, floor((已用时间 / 预估时间) * 100))
- 最大显示 95%，防止卡在 100% 但未完成的情况
- 进度只增不减（单调递增）

---

### 6. `nanobanana_completed` - 生成成功完成

```json
{
  "type": "nanobanana_completed",
  "timestamp": "2026-02-14T08:01:00.000Z",
  "task_id": "task_abc123xyz",
  "status": "completed",
  "elapsed_seconds": 58,
  "credits_estimated": 10,
  "credits_actual": 8,
  "image_urls": [
    "https://example.com/generated/img1.jpg"
  ],
  "image_count": 1
}
```

**字段说明**：
- `status`: 固定为 `completed`
- `elapsed_seconds`: 实际耗时（秒）
- `credits_estimated`: 任务提交时的预估积分
- `credits_actual`: 实际扣除的积分（可能比预估少）
- `image_urls`: 生成的图片下载 URL 数组
- `image_count`: 生成的图片数量

---

### 7. `nanobanana_failed` - 生成失败

```json
{
  "type": "nanobanana_failed",
  "timestamp": "2026-02-14T08:01:00.000Z",
  "task_id": "task_abc123xyz",
  "status": "failed",
  "error": "Content policy violation",
  "elapsed_seconds": 10
}
```

**字段说明**：
- `status`: 固定为 `failed`
- `error`: 失败原因
- `elapsed_seconds`: 失败前的耗时

---

### 8. `nanobanana_error` - 轮询错误或超时

```json
{
  "type": "nanobanana_error",
  "timestamp": "2026-02-14T08:05:00.000Z",
  "task_id": "task_abc123xyz",
  "error": "Task timeout after 180 seconds",
  "elapsed_seconds": 180
}
```

**字段说明**：
- `error`: 错误消息（超时、网络错误等）

---

## 完整示例

### 命令

```bash
easycode --output-format stream-json --yolo "/nanobanana auto 1k 一个可爱的小猫照片"
```

### 输出（完整流）

```json
# stdout
{"type":"init","session_id":"session_123","model":"gemini-2.0-flash-exp"}
{"type":"message","role":"user","content":"/nanobanana auto 1k 一个可爱的小猫照片"}

# stderr - 进度事件
{"type":"nanobanana_submitted","timestamp":"2026-02-14T08:00:00.000Z","task_id":"task_abc","prompt":"一个可爱的小猫照片","ratio":"auto","size":"1k","reference_image":null,"reference_image_url":null,"estimated_time_seconds":60,"credits_estimated":10}
{"type":"nanobanana_progress","timestamp":"2026-02-14T08:00:02.000Z","task_id":"task_abc","status":"pending","elapsed_seconds":2,"estimated_seconds":60,"progress_percent":3}
{"type":"nanobanana_progress","timestamp":"2026-02-14T08:00:04.000Z","task_id":"task_abc","status":"processing","elapsed_seconds":4,"estimated_seconds":60,"progress_percent":6}
{"type":"nanobanana_progress","timestamp":"2026-02-14T08:00:06.000Z","task_id":"task_abc","status":"processing","elapsed_seconds":6,"estimated_seconds":60,"progress_percent":10}
{"type":"nanobanana_progress","timestamp":"2026-02-14T08:00:08.000Z","task_id":"task_abc","status":"processing","elapsed_seconds":8,"estimated_seconds":60,"progress_percent":13}
...
{"type":"nanobanana_progress","timestamp":"2026-02-14T08:00:56.000Z","task_id":"task_abc","status":"processing","elapsed_seconds":56,"estimated_seconds":60,"progress_percent":93}
{"type":"nanobanana_completed","timestamp":"2026-02-14T08:00:58.000Z","task_id":"task_abc","status":"completed","elapsed_seconds":58,"credits_estimated":10,"credits_actual":8,"image_urls":["https://cdn.easycode.com/gen/img_abc123.jpg"],"image_count":1}

# stdout - 最终结果
{"type":"message","role":"assistant","content":"✅ Image generation completed successfully for prompt: \"一个可爱的小猫照片\""}
{"type":"result","status":"success","stats":{"total_tokens":0,"input_tokens":0,"output_tokens":0,"duration_ms":0}}
```

---

## 脚本化处理示例

### Bash 脚本：提取图片 URL

```bash
#!/bin/bash

# 执行命令并分离 stderr
easycode --output-format stream-json --yolo "/nanobanana auto 1k 一个可爱的小猫" 2> >(
  while IFS= read -r line; do
    echo "$line" | jq -r 'select(.type == "nanobanana_completed") | .image_urls[]'
  done
)
```

### Python 脚本：实时进度监控

```python
import subprocess
import json
import sys

process = subprocess.Popen(
    ['easycode', '--output-format', 'stream-json', '--yolo', '/nanobanana auto 1k 一个可爱的小猫'],
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True
)

# 监控 stderr 中的进度事件
for line in process.stderr:
    try:
        event = json.loads(line.strip())
        event_type = event.get('type', '')

        if event_type == 'nanobanana_submitted':
            print(f"✅ 任务已提交: {event['task_id']}")
            print(f"   预估时间: {event['estimated_time_seconds']}秒")
            print(f"   预估积分: {event['credits_estimated']}")

        elif event_type == 'nanobanana_progress':
            print(f"⏳ 进度: {event['progress_percent']}% ({event['elapsed_seconds']}s)")

        elif event_type == 'nanobanana_completed':
            print(f"🎉 完成! 实际积分: {event['credits_actual']}")
            print(f"📸 图片URL:")
            for url in event['image_urls']:
                print(f"   {url}")
            break

        elif event_type == 'nanobanana_failed':
            print(f"❌ 失败: {event['error']}")
            sys.exit(1)

    except json.JSONDecodeError:
        pass

process.wait()
```

---

## 注意事项

1. **stderr vs stdout**：进度事件输出到 stderr，避免污染 stdout 的 JSON 流
2. **事件顺序**：事件严格按时间顺序输出
3. **虚拟进度**：`progress_percent` 是基于时间估算的虚拟进度，不代表实际生成进度
4. **积分差异**：`credits_actual` 可能小于 `credits_estimated`，服务器会根据实际使用情况扣费
5. **超时时间**：默认超时为 `estimated_time + 120` 秒
6. **轮询间隔**：非交互模式下每 2 秒轮询一次状态

---

## 相关文档

- [非交互模式斜杠命令支持](./noninteractive-slash-commands.md)
- [NanoBanana 命令使用指南](./nanobanana-guide.md)
- [JSON 流式输出格式](./stream-json-output.md)
