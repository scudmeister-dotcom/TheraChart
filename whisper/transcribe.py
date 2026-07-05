#!/usr/bin/env python3
"""TheraChart Whisper transcriber (self-hosted, runs on the clinic server).

Usage:  python3 whisper/transcribe.py <audio.wav> [language]
Prints the transcript to stdout. Audio never leaves this machine.

Setup (once, on the clinic server):
    pip install faster-whisper
    # the model (~75 MB for tiny … ~500 MB for small) downloads on first run
    # and is cached locally after that

Environment:
    WHISPER_MODEL  tiny | base | small | medium | large-v3   (default: small)
                   Use tiny/base on older CPUs, small+ when accuracy matters.

Language argument: en | tl | auto  (Cebuano has no dedicated Whisper language;
'auto' lets the model detect, which handles Cebuano/Taglish best.)
"""

import os
import sys

def main():
    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio.wav> [language]", file=sys.stderr)
        return 2

    audio = sys.argv[1]
    lang = sys.argv[2] if len(sys.argv) > 2 else "auto"
    if lang in ("auto", "", "ceb"):
        lang = None  # let Whisper auto-detect (best for Cebuano / code-switching)

    from faster_whisper import WhisperModel

    model_size = os.environ.get("WHISPER_MODEL", "small")
    # int8 keeps CPU-only clinics fast; a GPU is used automatically if present
    model = WhisperModel(model_size, device="auto", compute_type="int8")

    segments, _info = model.transcribe(
        audio,
        language=lang,
        vad_filter=True,
        beam_size=1,
    )
    print(" ".join(s.text.strip() for s in segments).strip())
    return 0

if __name__ == "__main__":
    sys.exit(main())
