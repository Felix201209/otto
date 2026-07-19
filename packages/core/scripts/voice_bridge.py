#!/usr/bin/env python3
"""
Otto Voice Bridge - Lightweight voice input for Otto Agent
Record -> Transcribe -> Polish -> Output structured command

Platform support:
  macOS:   ffmpeg + avfoundation
  Windows: ffmpeg + dshow (auto-detect mic name) or sounddevice fallback
"""

import sys, os, json, subprocess, tempfile, argparse, wave, glob

def find_windows_mic():
    """Auto-detect Windows microphone device name for ffmpeg dshow."""
    try:
        result = subprocess.run(
            ['ffmpeg', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
            capture_output=True, text=True, timeout=5
        )
        # Parse stderr for audio devices
        lines = (result.stderr or '').split('\n')
        in_audio = False
        for line in lines:
            if 'DirectShow audio devices' in line:
                in_audio = True
                continue
            if in_audio and 'DirectShow video devices' in line:
                break
            if in_audio and '"' in line:
                # Extract device name between quotes
                parts = line.split('"')
                if len(parts) >= 2:
                    name = parts[1]
                    if name and name != 'dummy':
                        return name
    except:
        pass
    return None

def record_audio(duration=10, sample_rate=16000):
    tmp_wav = tempfile.NamedTemporaryFile(suffix='.wav', delete=False).name
    cmd = None

    if sys.platform == 'darwin':
        # macOS: ffmpeg + avfoundation, :0 = first audio input
        cmd = ['ffmpeg', '-y', '-f', 'avfoundation', '-i', ':0',
               '-t', str(duration), '-ar', str(sample_rate), '-ac', '1', tmp_wav]

    elif sys.platform == 'win32':
        # Windows: ffmpeg + dshow, auto-detect mic
        mic_name = find_windows_mic()
        if mic_name:
            cmd = ['ffmpeg', '-y', '-f', 'dshow',
                   '-i', f'audio={mic_name}',
                   '-t', str(duration), '-ar', str(sample_rate), '-ac', '1', tmp_wav]
        else:
            # Fallback: try default "Microphone"
            cmd = ['ffmpeg', '-y', '-f', 'dshow',
                   '-i', 'audio=Microphone',
                   '-t', str(duration), '-ar', str(sample_rate), '-ac', '1', tmp_wav]

    if cmd:
        try:
            subprocess.run(cmd, timeout=duration+5, capture_output=True)
            if os.path.exists(tmp_wav) and os.path.getsize(tmp_wav) > 100:
                return tmp_wav
            else:
                print("ffmpeg produced empty file, trying sounddevice", file=sys.stderr)
        except Exception as e:
            print(f"ffmpeg error: {e}", file=sys.stderr)

    # Universal fallback: Python sounddevice (works on all platforms)
    try:
        import sounddevice as sd
        print("Using sounddevice for recording", file=sys.stderr)
        recording = sd.rec(int(duration * sample_rate), samplerate=sample_rate,
                          channels=1, dtype='int16')
        sd.wait()
        with wave.open(tmp_wav, 'w') as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(recording.tobytes())
        return tmp_wav
    except ImportError:
        print("No audio method available.", file=sys.stderr)
        print("  macOS: ffmpeg should be built with avfoundation", file=sys.stderr)
        print("  Windows: ffmpeg should be built with dshow, or: pip install sounddevice", file=sys.stderr)

    return None


def transcribe(audio_path, method='auto'):
    """Transcribe audio file to text."""

    # Method 1: local whisper (best for privacy, works offline)
    if method in ('auto', 'whisper'):
        try:
            result = subprocess.run(
                [sys.executable, '-c', '''
import sys, ssl
# Workaround for macOS SSL certificate issues
try:
    ssl._create_default_https_context = ssl._create_unverified_context
except:
    pass
try:
    import whisper
    model = whisper.load_model("base")
    result = model.transcribe(sys.argv[1])
    print(result["text"])
except ImportError:
    sys.exit(1)
''', audio_path],
                capture_output=True, text=True, timeout=90
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except:
            pass

    # Method 2: cloud API (OpenAI Whisper compatible)
    if method in ('auto', 'api'):
        api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('ARK_API_KEY')
        if api_key:
            try:
                import requests
                # Support both OpenAI and Ark endpoints
                endpoint = os.environ.get('OPENAI_API_BASE', 'https://api.openai.com/v1')
                if 'ark' in endpoint.lower():
                    url = endpoint + '/audio/transcriptions'
                else:
                    url = 'https://api.openai.com/v1/audio/transcriptions'

                headers = {"Authorization": f"Bearer {api_key}"}
                files = {"file": open(audio_path, 'rb')}
                data = {"model": "whisper-1"}
                resp = requests.post(url, headers=headers, files=files, data=data, timeout=30)
                if resp.status_code == 200:
                    return resp.json().get('text', '').strip()
            except Exception as e:
                print(f"API transcribe error: {e}", file=sys.stderr)

    # Method 3: macOS Speech Recognition (built-in, no install needed)
    if method in ('auto', 'macos') and sys.platform == 'darwin':
        try:
            script = f'''
            set audioFile to POSIX file "{audio_path}"
            tell application "SpeechRecognitionServer"
                set theResult to listen for audioFile
                return theResult
            end tell
            '''
            result = subprocess.run(['osascript', '-e', script],
                                    capture_output=True, text=True, timeout=30)
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()
        except:
            pass

    return None


def polish_to_command(raw_text, mode='polished'):
    """Polish raw speech into structured Otto command via LLM."""
    if mode == 'raw':
        return raw_text

    api_key = os.environ.get('OPENAI_API_KEY') or os.environ.get('ARK_API_KEY')
    endpoint = os.environ.get('ARK_ENDPOINT', '')
    model = os.environ.get('ARK_MODEL_ID', os.environ.get('OPENAI_MODEL', 'gpt-4o-mini'))

    if not api_key:
        # No LLM: basic cleanup only
        text = raw_text.strip()
        # Remove common fillers
        for filler in ['uh', 'um', 'ah', '那个', '嗯', '就是', '然后']:
            text = text.replace(filler, '')
        return text.strip()

    system_prompt = """You are Otto Agent's voice input processor.
Convert spoken office tasks into clean structured instructions.

Rules:
1. Keep user's intent exactly
2. Remove filler words (uh, um, 那个, 嗯, 就是)
3. Keep the user's language (Chinese stays Chinese, English stays English)
4. Output ONLY the cleaned instruction, no explanations

Examples:
Input: "uh... help me turn that sales csv on desktop into a chart"
Output: "帮我把桌面上的sales.csv文件画成图表"

Input: "我的电脑好卡帮我看看怎么回事"
Output: "诊断我的电脑，检查内存和进程"

Input: "把桌面那个Word文档转成PDF发给客户"
Output: "把桌面上的Word文档转换为PDF格式"
"""
    try:
        import requests

        if endpoint and 'ark' in endpoint.lower():
            url = endpoint
        elif os.environ.get('OPENAI_API_BASE'):
            url = os.environ['OPENAI_API_BASE'] + '/chat/completions'
        else:
            url = 'https://api.openai.com/v1/chat/completions'

        resp = requests.post(url,
            headers={
                'Authorization': f'Bearer {api_key}',
                'Content-Type': 'application/json'
            },
            json={
                'model': model,
                'messages': [
                    {'role': 'system', 'content': system_prompt},
                    {'role': 'user', 'content': raw_text}
                ],
                'temperature': 0.3,
                'max_tokens': 200
            },
            timeout=15
        )
        if resp.status_code == 200:
            return resp.json()['choices'][0]['message']['content'].strip()
    except Exception as e:
        print(f"Polish error: {e}", file=sys.stderr)

    return raw_text.strip()


def main():
    parser = argparse.ArgumentParser(description='Otto Voice Bridge')
    parser.add_argument('--input-file',
                       help='Existing audio file to transcribe. If provided, skip microphone recording.')
    parser.add_argument('--duration', type=int, default=10,
                       help='Recording duration in seconds (default: 10)')
    parser.add_argument('--mode', choices=['raw', 'polished'], default='polished',
                       help='Output mode: raw=transcript only, polished=LLM structured')
    parser.add_argument('--transcribe-only', action='store_true',
                       help='Skip LLM polish, return raw transcript')
    args = parser.parse_args()

    # Step 1: Use an existing file or record from the microphone
    cleanup_audio = False
    if args.input_file:
        audio_path = args.input_file
        if not os.path.exists(audio_path):
            print(f"ERROR: Input audio file not found: {audio_path}", file=sys.stderr)
            sys.exit(1)
    else:
        print(f"Recording {args.duration}s...", file=sys.stderr)
        audio_path = record_audio(duration=args.duration)
        cleanup_audio = True
        if not audio_path:
            print("ERROR: Recording failed. Check microphone permissions.", file=sys.stderr)
            sys.exit(1)

    # Step 2: Transcribe
    print("Transcribing...", file=sys.stderr)
    text = transcribe(audio_path)

    # Cleanup
    if cleanup_audio:
        try:
            os.unlink(audio_path)
        except:
            pass

    if not text:
        print("ERROR: Transcription failed.", file=sys.stderr)
        print("  Install whisper: pip install openai-whisper", file=sys.stderr)
        print("  Or set OPENAI_API_KEY for cloud transcription", file=sys.stderr)
        sys.exit(1)

    # Step 3: Polish (or skip)
    if args.transcribe_only:
        print(text)
    else:
        print("Polishing...", file=sys.stderr)
        result = polish_to_command(text, args.mode)
        print(result)

if __name__ == '__main__':
    main()
