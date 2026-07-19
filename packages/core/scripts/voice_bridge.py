#!/usr/bin/env python3
"""
Otto Voice Bridge - lightweight voice input for Otto Agent.

Record or read audio -> transcribe -> optionally polish -> output text.

Platform support:
  macOS:   ffmpeg + avfoundation, then sounddevice fallback
  Windows: ffmpeg + dshow auto-detect, then sounddevice fallback
  Linux:   sounddevice fallback for recording
"""

import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import wave


DEFAULT_WHISPER_MODEL = os.environ.get("OTTO_WHISPER_MODEL", "auto").strip() or "auto"
DEFAULT_WHISPER_LANGUAGE = os.environ.get("OTTO_WHISPER_LANGUAGE", "").strip() or None
DEFAULT_WHISPER_INITIAL_PROMPT = os.environ.get(
    "OTTO_WHISPER_INITIAL_PROMPT",
    "This is a Chinese or Chinese-English office meeting, voice memo, or user command. "
    "Recognize names, companies, product names, numbers, dates, money amounts, tasks, conclusions, and action items. "
    "Preserve the original language and do not translate.",
)
DEFAULT_WHISPER_TIMEOUT = int(os.environ.get("OTTO_WHISPER_TIMEOUT", "300"))
DEFAULT_WHISPER_BEAM_SIZE = int(os.environ.get("OTTO_WHISPER_BEAM_SIZE", "5"))
DEFAULT_WHISPER_TEMPERATURES = os.environ.get("OTTO_WHISPER_TEMPERATURES", "0,0.2").strip()
DEFAULT_WHISPER_NO_SPEECH_THRESHOLD = float(os.environ.get("OTTO_WHISPER_NO_SPEECH_THRESHOLD", "0.6"))
DEFAULT_WHISPER_LOGPROB_THRESHOLD = float(os.environ.get("OTTO_WHISPER_LOGPROB_THRESHOLD", "-1.0"))
DEFAULT_WHISPER_COMPRESSION_RATIO_THRESHOLD = float(os.environ.get("OTTO_WHISPER_COMPRESSION_RATIO_THRESHOLD", "2.4"))
DEFAULT_ASR_BACKEND = os.environ.get("OTTO_ASR_BACKEND", "auto").strip().lower() or "auto"
SUPPORTED_ASR_BACKENDS = {"auto", "faster-whisper", "faster_whisper", "openai-whisper", "openai_whisper", "whisper"}
DEFAULT_ASR_BACKEND_VALID = DEFAULT_ASR_BACKEND in SUPPORTED_ASR_BACKENDS
DEFAULT_FASTER_WHISPER_DEVICE = os.environ.get("OTTO_FASTER_WHISPER_DEVICE", "auto").strip() or "auto"
DEFAULT_FASTER_WHISPER_COMPUTE_TYPE = os.environ.get("OTTO_FASTER_WHISPER_COMPUTE_TYPE", "default").strip() or "default"
NO_SPEECH_EXIT_CODE = 3
NO_SPEECH = object()


def whisper_model_candidates():
    """Return the local model fallback order. auto favors accuracy, then compatibility."""
    configured = (os.environ.get("OTTO_WHISPER_MODEL") or DEFAULT_WHISPER_MODEL).strip()
    if configured and configured != "auto":
        return [configured]
    return ["medium", "small", "base"]


def check_dependencies():
    """Report the dependencies this exact Python runtime can use."""
    whisper_available = importlib.util.find_spec("whisper") is not None
    faster_whisper_available = importlib.util.find_spec("faster_whisper") is not None
    sounddevice_available = importlib.util.find_spec("sounddevice") is not None
    requests_available = importlib.util.find_spec("requests") is not None
    torch_available = importlib.util.find_spec("torch") is not None
    cuda_available = False
    if torch_available:
        try:
            import torch
            cuda_available = bool(torch.cuda.is_available())
        except Exception:
            pass
    if faster_whisper_available:
        try:
            import ctranslate2
            cuda_available = cuda_available or ctranslate2.get_cuda_device_count() > 0
        except Exception:
            pass
    return {
        "python": sys.executable,
        "python_version": sys.version.split()[0],
        "ffmpeg": shutil.which("ffmpeg"),
        "whisper_module": whisper_available,
        "faster_whisper_module": faster_whisper_available,
        "sounddevice_module": sounddevice_available,
        "requests_module": requests_available,
        "torch_module": torch_available,
        "cuda": cuda_available,
        "user_asr_key": bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("ARK_API_KEY")),
        "model_candidates": whisper_model_candidates(),
        "asr_backend": DEFAULT_ASR_BACKEND,
        "asr_backend_valid": DEFAULT_ASR_BACKEND_VALID,
        "beam_size": DEFAULT_WHISPER_BEAM_SIZE,
        "temperature_schedule": DEFAULT_WHISPER_TEMPERATURES,
        "faster_whisper_device": DEFAULT_FASTER_WHISPER_DEVICE,
        "faster_whisper_compute_type": DEFAULT_FASTER_WHISPER_COMPUTE_TYPE,
        "timeout_seconds": DEFAULT_WHISPER_TIMEOUT,
    }


def find_windows_mic():
    """Auto-detect Windows microphone device name for ffmpeg dshow."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        lines = (result.stderr or "").splitlines()
        in_audio = False
        for line in lines:
            if "DirectShow audio devices" in line:
                in_audio = True
                continue
            if in_audio and "DirectShow video devices" in line:
                break
            if in_audio and '"' in line:
                parts = line.split('"')
                if len(parts) >= 2:
                    name = parts[1]
                    if name and name != "dummy":
                        return name
    except Exception:
        pass
    return None


def record_audio(duration=10, sample_rate=16000):
    tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    cmd = None

    if sys.platform == "darwin":
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "avfoundation",
            "-i",
            ":0",
            "-t",
            str(duration),
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            tmp_wav,
        ]
    elif sys.platform == "win32":
        mic_name = find_windows_mic()
        audio_input = f"audio={mic_name}" if mic_name else "audio=Microphone"
        cmd = [
            "ffmpeg",
            "-y",
            "-f",
            "dshow",
            "-i",
            audio_input,
            "-t",
            str(duration),
            "-ar",
            str(sample_rate),
            "-ac",
            "1",
            tmp_wav,
        ]

    if cmd:
        try:
            subprocess.run(cmd, timeout=duration + 8, capture_output=True)
            if os.path.exists(tmp_wav) and os.path.getsize(tmp_wav) > 100:
                return tmp_wav
            print("ffmpeg produced empty audio; trying sounddevice.", file=sys.stderr)
        except Exception as e:
            print(f"ffmpeg recording error: {e}; trying sounddevice.", file=sys.stderr)

    try:
        import sounddevice as sd

        print("Using sounddevice for recording.", file=sys.stderr)
        recording = sd.rec(
            int(duration * sample_rate),
            samplerate=sample_rate,
            channels=1,
            dtype="int16",
        )
        sd.wait()
        with wave.open(tmp_wav, "w") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(sample_rate)
            wf.writeframes(recording.tobytes())
        return tmp_wav
    except ImportError:
        print("No recording method available.", file=sys.stderr)
        print("Install ffmpeg, or install sounddevice: pip install sounddevice", file=sys.stderr)
    except Exception as e:
        print(f"sounddevice recording error: {e}", file=sys.stderr)

    return None


def normalize_audio_for_asr(audio_path):
    """Convert varied containers/codecs to a Whisper-friendly mono 16 kHz WAV."""
    if not shutil.which("ffmpeg"):
        return audio_path, False

    tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        audio_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-af",
        "aresample=async=1:first_pts=0",
        tmp_wav,
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=90)
        if result.returncode == 0 and os.path.exists(tmp_wav) and os.path.getsize(tmp_wav) > 100:
            return tmp_wav, True
        print("ffmpeg normalization did not produce usable audio; using original file.", file=sys.stderr)
    except Exception as e:
        print(f"ffmpeg normalization error: {e}; using original file.", file=sys.stderr)

    try:
        os.unlink(tmp_wav)
    except Exception:
        pass
    return audio_path, False


def transcribe_with_local_whisper(audio_path):
    env = os.environ.copy()
    env.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    env.setdefault("OTTO_WHISPER_LANGUAGE", DEFAULT_WHISPER_LANGUAGE or "")
    env.setdefault("OTTO_WHISPER_INITIAL_PROMPT", DEFAULT_WHISPER_INITIAL_PROMPT)
    env["OTTO_WHISPER_MODEL_CANDIDATES"] = json.dumps(whisper_model_candidates())
    env.setdefault("OTTO_WHISPER_BEAM_SIZE", str(DEFAULT_WHISPER_BEAM_SIZE))
    env.setdefault("OTTO_WHISPER_TEMPERATURES", DEFAULT_WHISPER_TEMPERATURES)
    env.setdefault("OTTO_WHISPER_NO_SPEECH_THRESHOLD", str(DEFAULT_WHISPER_NO_SPEECH_THRESHOLD))
    env.setdefault("OTTO_WHISPER_LOGPROB_THRESHOLD", str(DEFAULT_WHISPER_LOGPROB_THRESHOLD))
    env.setdefault("OTTO_WHISPER_COMPRESSION_RATIO_THRESHOLD", str(DEFAULT_WHISPER_COMPRESSION_RATIO_THRESHOLD))
    env.setdefault("OTTO_ASR_BACKEND", DEFAULT_ASR_BACKEND)
    env.setdefault("OTTO_FASTER_WHISPER_DEVICE", DEFAULT_FASTER_WHISPER_DEVICE)
    env.setdefault("OTTO_FASTER_WHISPER_COMPUTE_TYPE", DEFAULT_FASTER_WHISPER_COMPUTE_TYPE)
    env["OTTO_NO_SPEECH_EXIT_CODE"] = str(NO_SPEECH_EXIT_CODE)

    code = r'''
import json
import os
import sys

try:
    import torch
    fp16 = bool(torch.cuda.is_available())
except Exception:
    fp16 = False

audio_path = sys.argv[1]
models = json.loads(os.environ.get("OTTO_WHISPER_MODEL_CANDIDATES", '["medium","small","base"]'))
language = os.environ.get("OTTO_WHISPER_LANGUAGE") or None
initial_prompt = os.environ.get("OTTO_WHISPER_INITIAL_PROMPT") or None
beam_size = int(os.environ.get("OTTO_WHISPER_BEAM_SIZE", "5"))
temperatures = tuple(float(t.strip()) for t in os.environ.get("OTTO_WHISPER_TEMPERATURES", "0,0.2").split(",") if t.strip())
no_speech_threshold = float(os.environ.get("OTTO_WHISPER_NO_SPEECH_THRESHOLD", "0.6"))
logprob_threshold = float(os.environ.get("OTTO_WHISPER_LOGPROB_THRESHOLD", "-1.0"))
compression_ratio_threshold = float(os.environ.get("OTTO_WHISPER_COMPRESSION_RATIO_THRESHOLD", "2.4"))
backend = os.environ.get("OTTO_ASR_BACKEND", "auto").lower()
faster_device = os.environ.get("OTTO_FASTER_WHISPER_DEVICE", "auto")
faster_compute_type = os.environ.get("OTTO_FASTER_WHISPER_COMPUTE_TYPE", "default")
no_speech_exit_code = int(os.environ.get("OTTO_NO_SPEECH_EXIT_CODE", "3"))
supported_backends = {"auto", "faster-whisper", "faster_whisper", "openai-whisper", "openai_whisper", "whisper"}
if backend not in supported_backends:
    print(f"Unsupported OTTO_ASR_BACKEND: {backend}", file=sys.stderr)
    sys.exit(2)
last_error = None

def run_faster_whisper():
    from faster_whisper import WhisperModel

    last = None
    for model_name in models:
        try:
            model = WhisperModel(
                model_name,
                device=faster_device,
                compute_type=faster_compute_type,
            )
            segments, _info = model.transcribe(
                audio_path,
                language=language,
                initial_prompt=initial_prompt,
                beam_size=beam_size,
                temperature=temperatures or (0,),
                vad_filter=True,
                vad_parameters={
                    "min_silence_duration_ms": 500,
                    "speech_pad_ms": 250,
                },
                condition_on_previous_text=True,
                no_speech_threshold=no_speech_threshold,
                log_prob_threshold=logprob_threshold,
                compression_ratio_threshold=compression_ratio_threshold,
            )
            text = "".join((segment.text or "") for segment in segments).strip()
            if text:
                print(text)
                return True
            print(f"{model_name} detected no speech.", file=sys.stderr)
            return False
        except Exception as e:
            last = f"{model_name}: {e}"
            print(f"faster-whisper model failed, trying next if available: {last}", file=sys.stderr)
    raise RuntimeError(last or "faster-whisper returned no text")

def run_openai_whisper():
    import whisper

    last = None
    for model_name in models:
        try:
            model = whisper.load_model(model_name)
            result = model.transcribe(
                audio_path,
                language=language,
                initial_prompt=initial_prompt,
                temperature=temperatures or (0,),
                beam_size=beam_size,
                best_of=beam_size,
                condition_on_previous_text=True,
                fp16=fp16,
                no_speech_threshold=no_speech_threshold,
                logprob_threshold=logprob_threshold,
                compression_ratio_threshold=compression_ratio_threshold,
                verbose=False,
            )
            text = (result.get("text") or "").strip()
            if text:
                print(text)
                return True
            print(f"{model_name} detected no speech.", file=sys.stderr)
            return False
        except Exception as e:
            last = f"{model_name}: {e}"
            print(f"Whisper model failed, trying next if available: {last}", file=sys.stderr)
    raise RuntimeError(last or "Whisper returned no text")

errors = []
if backend in ("auto", "faster-whisper", "faster_whisper"):
    try:
        import faster_whisper  # noqa: F401
        faster_result = run_faster_whisper()
        if faster_result:
            sys.exit(0)
        if faster_result is False:
            sys.exit(no_speech_exit_code)
    except Exception as e:
        errors.append(f"faster-whisper: {e}")
        print(f"faster-whisper unavailable or failed: {e}", file=sys.stderr)

if backend in ("auto", "openai-whisper", "openai_whisper", "whisper"):
    try:
        openai_result = run_openai_whisper()
        if openai_result:
            sys.exit(0)
        if openai_result is False:
            sys.exit(no_speech_exit_code)
    except ImportError:
        errors.append("openai-whisper Python module is not installed")
    except Exception as e:
        errors.append(f"openai-whisper: {e}")

print("; ".join(errors) or last_error or "Whisper returned no text.", file=sys.stderr)
sys.exit(2)
'''

    try:
        result = subprocess.run(
            [sys.executable, "-c", code, audio_path],
            capture_output=True,
            text=True,
            timeout=DEFAULT_WHISPER_TIMEOUT,
            env=env,
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
        if result.returncode == NO_SPEECH_EXIT_CODE:
            if result.stderr.strip():
                print(result.stderr.strip(), file=sys.stderr)
            return NO_SPEECH
        if result.stderr.strip():
            print(result.stderr.strip(), file=sys.stderr)
    except subprocess.TimeoutExpired:
        print(
            f"Local Whisper timed out after {DEFAULT_WHISPER_TIMEOUT}s. "
            "Try OTTO_WHISPER_MODEL=small or OTTO_WHISPER_TIMEOUT=600.",
            file=sys.stderr,
        )
    except Exception as e:
        print(f"Local Whisper error: {e}", file=sys.stderr)

    return None


def transcribe_with_user_api(audio_path):
    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("ARK_API_KEY")
    if not api_key:
        return None

    try:
        import requests

        endpoint = os.environ.get("OPENAI_API_BASE", "https://api.openai.com/v1")
        url = endpoint.rstrip("/") + "/audio/transcriptions"
        headers = {"Authorization": f"Bearer {api_key}"}
        with open(audio_path, "rb") as f:
            files = {"file": f}
            data = {"model": os.environ.get("OTTO_ASR_MODEL", "whisper-1")}
            resp = requests.post(url, headers=headers, files=files, data=data, timeout=60)
        if resp.status_code == 200:
            return resp.json().get("text", "").strip()
        print(f"User ASR API failed: HTTP {resp.status_code} {resp.text[:300]}", file=sys.stderr)
    except Exception as e:
        print(f"User ASR API error: {e}", file=sys.stderr)

    return None


def transcribe_with_macos_speech(audio_path):
    if sys.platform != "darwin":
        return None
    try:
        script = f'''
        set audioFile to POSIX file "{audio_path}"
        tell application "SpeechRecognitionServer"
            set theResult to listen for audioFile
            return theResult
        end tell
        '''
        result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=45)
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception:
        pass
    return None


def transcribe(audio_path, method="auto"):
    """Transcribe audio file to text."""
    normalized_path, should_cleanup = normalize_audio_for_asr(audio_path)
    try:
        if method in ("auto", "whisper"):
            text = transcribe_with_local_whisper(normalized_path)
            if text is NO_SPEECH:
                return None
            if text:
                return text

        if method in ("auto", "api"):
            text = transcribe_with_user_api(normalized_path)
            if text:
                return text

        if method in ("auto", "macos"):
            text = transcribe_with_macos_speech(normalized_path)
            if text:
                return text
    finally:
        if should_cleanup:
            try:
                os.unlink(normalized_path)
            except Exception:
                pass

    return None


def polish_to_command(raw_text, mode="polished"):
    """Polish raw speech into structured Otto command via LLM."""
    if mode == "raw":
        return raw_text

    api_key = os.environ.get("OPENAI_API_KEY") or os.environ.get("ARK_API_KEY")
    endpoint = os.environ.get("ARK_ENDPOINT", "")
    model = os.environ.get("ARK_MODEL_ID", os.environ.get("OPENAI_MODEL", "gpt-4o-mini"))

    if not api_key:
        text = raw_text.strip()
        for filler in ["uh", "um", "ah", "like", "you know", "that thing", "basically"]:
            text = text.replace(filler, "")
        return text.strip()

    system_prompt = """You are Otto Agent's voice input processor.
Convert spoken office tasks into clean structured instructions.

Rules:
1. Keep the user's intent exactly.
2. Remove filler words.
3. Keep the user's language.
4. Output only the cleaned instruction, no explanations."""

    try:
        import requests

        if endpoint and "ark" in endpoint.lower():
            url = endpoint
        elif os.environ.get("OPENAI_API_BASE"):
            url = os.environ["OPENAI_API_BASE"].rstrip("/") + "/chat/completions"
        else:
            url = "https://api.openai.com/v1/chat/completions"

        resp = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": raw_text},
                ],
                "temperature": 0.3,
                "max_tokens": 200,
            },
            timeout=15,
        )
        if resp.status_code == 200:
            return resp.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"Polish error: {e}", file=sys.stderr)

    return raw_text.strip()


def main():
    parser = argparse.ArgumentParser(description="Otto Voice Bridge")
    parser.add_argument("--check-deps", action="store_true", help="Print dependency diagnostics as JSON and exit.")
    parser.add_argument(
        "--input-file",
        help="Existing audio file to transcribe. If provided, skip microphone recording.",
    )
    parser.add_argument("--duration", type=int, default=10, help="Recording duration in seconds.")
    parser.add_argument(
        "--mode",
        choices=["raw", "polished"],
        default="polished",
        help="Output mode: raw=transcript only, polished=LLM structured.",
    )
    parser.add_argument("--transcribe-only", action="store_true", help="Skip LLM polish.")
    args = parser.parse_args()

    if args.check_deps:
        print(json.dumps(check_dependencies(), ensure_ascii=False))
        return
    if not DEFAULT_ASR_BACKEND_VALID:
        print(
            f"ERROR: Unsupported OTTO_ASR_BACKEND={DEFAULT_ASR_BACKEND}. "
            "Use auto, faster-whisper, or openai-whisper.",
            file=sys.stderr,
        )
        sys.exit(2)

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

    print("Transcribing...", file=sys.stderr)
    text = transcribe(audio_path)

    if cleanup_audio:
        try:
            os.unlink(audio_path)
        except Exception:
            pass

    if not text:
        print("ERROR: Transcription failed.", file=sys.stderr)
        print("  Install local Whisper: pip install -U openai-whisper", file=sys.stderr)
        print("  Install ffmpeg for audio decoding.", file=sys.stderr)
        print("  Low-spec computer: set OTTO_WHISPER_MODEL=small", file=sys.stderr)
        sys.exit(1)

    if args.transcribe_only:
        print(text)
    else:
        print("Polishing...", file=sys.stderr)
        print(polish_to_command(text, args.mode))


if __name__ == "__main__":
    main()
