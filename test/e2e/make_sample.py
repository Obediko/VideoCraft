#!/usr/bin/env python3
"""Builds a realistic test recording: synthesized speech with natural pauses over a simple video.

Requires `pip install sherpa-onnx numpy soundfile` and a sherpa-onnx VITS/piper model directory
(SHERPA_TTS_DIR). The spoken script mixes off-topic chatter with the content a creator would
want in a short, so the pipeline's selection can be checked against known ground truth.
Writes <out>.mp4 and <out>.script.json (what was said, and when it was said).
"""
import json, os, subprocess, sys
import numpy as np
import sherpa_onnx
import soundfile as sf

out = sys.argv[1]
tts_dir = os.environ["SHERPA_TTS_DIR"]
model = [f for f in os.listdir(tts_dir) if f.endswith(".onnx")][0]
config = sherpa_onnx.OfflineTtsConfig(model=sherpa_onnx.OfflineTtsModelConfig(vits=sherpa_onnx.OfflineTtsVitsModelConfig(
    model=os.path.join(tts_dir, model), tokens=os.path.join(tts_dir, "tokens.txt"), data_dir=os.path.join(tts_dir, "espeak-ng-data")), num_threads=2))
tts = sherpa_onnx.OfflineTts(config)

# (text, pause_before_seconds, topical)
SCRIPT = [
    ("Hey everyone, welcome to the stream.", 0.6, False),
    ("I am just going to chat about a bunch of random things today.", 0.5, False),
    ("Um, I have no real plan, so let us see where this goes.", 0.7, False),
    ("Why do most new customers abandon your product during onboarding?", 1.8, True),
    ("The biggest mistake is asking for twenty form fields before they see any value.", 0.4, True),
    ("When we cut our onboarding flow down to three simple steps, activation doubled in a single month.", 0.4, True),
    ("Show people the value first, and collect the details later.", 0.4, True),
    ("Anyway, I think I left the oven on, so give me a moment.", 2.2, False),
    ("Okay, I am back. Where was I?", 1.2, False),
    ("Another thing that kills onboarding is a blank screen.", 1.6, True),
    ("Give new users a template or sample data so they can see the product working in under a minute.", 0.4, True),
    ("Thanks so much for watching, and see you in the next one.", 1.4, False),
]
rate = None
chunks, timeline, t = [], [], 0.0
for text, pause, topical in SCRIPT:
    audio = tts.generate(text, sid=0, speed=1.0)
    rate = audio.sample_rate
    chunks.append(np.zeros(int(pause * rate), dtype=np.float32)); t += pause
    samples = np.asarray(audio.samples, dtype=np.float32)
    chunks.append(samples)
    timeline.append({"text": text, "startS": round(t, 3), "endS": round(t + len(samples) / rate, 3), "topical": topical})
    t += len(samples) / rate
chunks.append(np.zeros(int(1.0 * rate), dtype=np.float32)); t += 1.0
wav = out + ".wav"
sf.write(wav, np.concatenate(chunks), rate)
json.dump({"durationS": round(t, 3), "sentences": timeline}, open(out + ".script.json", "w"), indent=1)
# A plain animated background with a moving bar so cuts are visible; real footage is not needed to test the pipeline.
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", f"color=c=0x1b2a41:s=1280x720:r=30:d={t:.3f}",
    "-i", wav, "-vf", "drawbox=x='mod(t*60,1180)':y=640:w=100:h=14:color=0xf2c14e:t=fill,drawtext=text='%{pts\\:hms}':fontcolor=white:fontsize=36:x=24:y=24",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out + ".mp4"], check=True)
print(json.dumps({"video": out + ".mp4", "durationS": round(t, 1)}))
