"""
make_video.py — 给演奏视频顶部加一条带进度的简谱字幕条。

思路：
  1. 用 ffmpeg 抽出音频，numpy 做谱通量起音检测（木琴的敲击很干脆）。
  2. 过滤掉明显偏弱的起音，按顺序与 .jianpu 的音符一一对应。
  3. 用 PIL 逐帧画字幕条（当前音高亮、歌词、已演奏/未演奏三态、进度条），
     通过管道喂给 ffmpeg，和原视频叠在一起，音频原样保留。

用法：
  python tools/performance-video/make_video.py \
      --video "D:/.../两只老虎-木琴.mp4" \
      --score docs/data/scores/two-tigers.jianpu \
      --out media/two-tigers-overlay.mp4 \
      --preview media/preview.jpg --preview-time 5.0
"""
import argparse
import bisect
import json
import math
import os
import shutil
import subprocess
import sys
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from align_robust import align_score_to_onsets

# ---------------- 可调参数 ----------------
STRIP_H = 240          # 字幕条高度（源视频 1080x1920，顶部墙面约 280px）
STRIP_ALPHA = 208      # 深色底的不透明度
ACCENT = (225, 138, 92)
INK = (245, 240, 233)
MUTED = (138, 126, 114)
PAST = (104, 196, 142)
FUTURE = (198, 187, 174)
SLOT = 112             # 每个音的横向间距
MARGIN = 56
DIGIT_SIZE = 64
LYRIC_SIZE = 36
FPS = 30000 / 1001

FONT_DIR = r"C:\Windows\Fonts"
FONT_BOLD = os.path.join(FONT_DIR, "msyhbd.ttc")
FONT_REG = os.path.join(FONT_DIR, "msyh.ttc")


def run(cmd, **kwargs):
    return subprocess.run(cmd, check=True, **kwargs)


def ffprobe_duration(ffprobe, video):
    out = run([ffprobe, "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", video],
              capture_output=True, text=True).stdout.strip()
    return float(out)


def ffprobe_color_info(ffprobe, video):
    """返回 (color_transfer, color_primaries, pix_fmt)。"""
    out = run([ffprobe, "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=color_transfer,color_primaries,pix_fmt",
               "-of", "json", video],
              capture_output=True, text=True, encoding="utf-8").stdout
    streams = json.loads(out).get("streams") or [{}]
    stream = streams[0]
    return (stream.get("color_transfer"),
            stream.get("color_primaries"),
            stream.get("pix_fmt"))


def color_filter(hdr, out_format):
    """HDR 源先 tone map 到 BT.709；SDR 源直接转目标像素格式，避免二次压暗。"""
    if hdr:
        return ("zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
                "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
                f"format={out_format}")
    return f"format={out_format}"


def extract_wav(ffmpeg, video, wav_path):
    run([ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-i", video,
         "-vn", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", wav_path])


def read_wav(path):
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
        ch = w.getnchannels()
    x = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def spectral_flux(x, sr, n_fft=2048, hop=256):
    win = np.hanning(n_fft).astype(np.float32)
    frames = 1 + max(0, (len(x) - n_fft) // hop)
    mag = np.empty((frames, n_fft // 2 + 1), dtype=np.float32)
    for k in range(frames):
        seg = x[k * hop:k * hop + n_fft] * win
        mag[k] = np.abs(np.fft.rfft(seg))
    logmag = np.log1p(10.0 * mag)
    diff = np.diff(logmag, axis=0, prepend=logmag[:1])
    diff = np.maximum(diff, 0.0)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    weight = 1.0 + 2.0 * (freqs >= 1500.0)
    env = (diff * weight).sum(axis=1)
    env /= env.max() + 1e-9
    return env, hop / sr


def moving_median(x, k):
    if k <= 1:
        return x
    pad = k // 2
    xp = np.pad(x, (pad, pad), mode="edge")
    out = np.empty_like(x)
    for i in range(len(x)):
        out[i] = np.median(xp[i:i + k])
    return out


def pick_peaks(env, dt, min_gap=0.12, rel=1.6, floor=0.035):
    sm = np.convolve(env, np.ones(3) / 3, mode="same")
    base = moving_median(sm, max(1, int(0.45 / dt)))
    th = np.maximum(base * rel, floor)
    cand = []
    for i in range(1, len(sm) - 1):
        if sm[i] >= sm[i - 1] and sm[i] > sm[i + 1] and sm[i] >= th[i]:
            cand.append(i)
    cand.sort(key=lambda i: sm[i], reverse=True)
    keep = []
    for i in cand:
        t = i * dt
        if all(abs(t - j * dt) >= min_gap for j in keep):
            keep.append(i)
    keep.sort()
    return [(i * dt, float(sm[i])) for i in keep]


def detect_onsets(wav_path):
    x, sr = read_wav(wav_path)
    env, dt = spectral_flux(x, sr)
    peaks = pick_peaks(env, dt)
    # 木琴演奏里真正敲击的强度通常 > 0.2；开头的环境声/收尾噪声会低很多
    strong = [p for p in peaks if p[1] >= 0.18]
    return strong, peaks


def load_score(node, score_path):
    if not os.path.exists(score_path):
        raise SystemExit(f"找不到曲谱文件：{score_path}")
    here = os.path.dirname(os.path.abspath(__file__))
    script = os.path.join(here, "score_to_json.mjs")
    if not os.path.exists(script):
        raise SystemExit(f"找不到曲谱解析脚本：{script}")
    try:
        proc = run([node, script, score_path], capture_output=True, text=True,
                   encoding="utf-8")
    except FileNotFoundError:
        raise SystemExit(f"找不到 Node，可执行文件：{node}")
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or exc.stdout or "").strip()
        raise SystemExit(f"解析曲谱失败：{score_path}\n{detail}")
    return json.loads(proc.stdout)


def beat_positions(notes):
    """每个音符的起拍位置（单位：拍）。"""
    starts = [0.0] * len(notes)
    beat = 0.0
    for i, note in enumerate(notes):
        starts[i] = beat
        beat += float(note.get("beat") or 1.0)
    return starts


def is_sounding(note):
    """0 是休止符、- 是延音，都不会产生新的起音。"""
    return str(note.get("pitch", "")) not in ("0", "-")


def sounding_items(score, sounding, starts):
    """把会响的音符转成 align_robust 需要的 items。

    关键：duration 要算到「下一个会响的音」为止，把中间的休止/延音也包进去，
    这样锚点的拍位置不会因为跳过休止符而整体前移。
    """
    notes = score["notes"]
    bars = set(score.get("bars") or [])
    total_beats = starts[-1] + float(notes[-1].get("beat") or 1.0)

    # 小节首音可能是休止符；真正作为锚点的是它后面第一个会响的音
    measure_starts = set()
    for boundary in [0] + sorted(bars):
        for index in sounding:
            if index >= boundary:
                measure_starts.add(index)
                break

    items = []
    for k, index in enumerate(sounding):
        next_index = sounding[k + 1] if k + 1 < len(sounding) else len(notes)
        end_beat = starts[next_index] if next_index < len(notes) else total_beats
        items.append({
            "note": str(notes[index].get("pitch", "")),
            "duration": max(end_beat - starts[index], 1e-3),
            "is_measure_start": index in measure_starts,
        })
    return items


def fill_times(notes, starts, sounding, time_by_index):
    """给休止符/延音补时间：在前后两个会响的音之间按拍位置线性插值。"""
    n = len(notes)
    times = [None] * n
    for index, value in time_by_index.items():
        times[index] = float(value)

    if not sounding:
        return [0.0] * n

    if len(sounding) > 1:
        b0, b1 = starts[sounding[0]], starts[sounding[-1]]
        sec_per_beat = (time_by_index[sounding[-1]] - time_by_index[sounding[0]]) / max(b1 - b0, 1e-6)
    else:
        sec_per_beat = 0.5
    if not math.isfinite(sec_per_beat) or sec_per_beat <= 0:
        sec_per_beat = 0.5

    for i in range(n):
        if times[i] is not None:
            continue
        prev = next((s for s in reversed(sounding) if s < i), None)
        nxt = next((s for s in sounding if s > i), None)

        # 延音是前一个音的一部分：跟上一个会响的音同一时刻，避免进度多走一格
        if str(notes[i].get("pitch", "")) == "-" and prev is not None:
            times[i] = times[prev]
        elif prev is not None and nxt is not None:
            frac = (starts[i] - starts[prev]) / max(starts[nxt] - starts[prev], 1e-6)
            times[i] = times[prev] + frac * (times[nxt] - times[prev])
        elif prev is not None:
            times[i] = times[prev] + (starts[i] - starts[prev]) * sec_per_beat
        elif nxt is not None:
            times[i] = times[nxt] - (starts[nxt] - starts[i]) * sec_per_beat
        else:
            times[i] = 0.0

    # 单调化，防止极端情况倒流
    for i in range(1, n):
        if times[i] < times[i - 1]:
            times[i] = times[i - 1]
    return times


def align(strong, score, *, force_robust=False, tolerance=0.35,
          skip_penalty=0.75, bpm=None):
    """起音 ↔ 会响的音符对齐；休止符/延音不参与起音计数。

    默认行为：起音数恰好等于「会响的音符数」时走 1:1（干净演奏最准）；
    数量不一致时自动切到 align_robust 的小节锚点对齐。`--robust` 可强制。
    """
    onsets = [t for t, _ in strong]
    notes = score["notes"]
    starts = beat_positions(notes)
    sounding = [i for i, note in enumerate(notes) if is_sounding(note)]

    if len(onsets) == len(sounding) and not force_robust:
        time_by_index = {index: onsets[k] for k, index in enumerate(sounding)}
        return fill_times(notes, starts, sounding, time_by_index), {
            "mode": "1:1",
            "matched": [],
            "sounding": len(sounding),
        }

    items = sounding_items(score, sounding, starts)
    mapping, debug = align_score_to_onsets(
        onsets,
        items,
        bpm=bpm,
        tolerance=tolerance,
        skip_penalty=skip_penalty,
        return_debug=True,
    )
    time_by_index = {index: mapping[k] for k, index in enumerate(sounding)}
    debug["mode"] = "anchor-robust"
    debug["sounding"] = len(sounding)
    return fill_times(notes, starts, sounding, time_by_index), debug


def lookup_title(score_path):
    """从同目录的 index.json 里取标题；取不到就用文件 ID。"""
    sid = os.path.splitext(os.path.basename(score_path))[0]
    index_path = os.path.join(os.path.dirname(score_path), "index.json")
    try:
        with open(index_path, encoding="utf-8") as fh:
            data = json.load(fh)
        for item in data.get("scores", []):
            if item.get("id") == sid:
                return item.get("title") or sid
    except (OSError, ValueError):
        pass
    return sid


def fmt_note(n):
    p = n["pitch"]
    if p == "0":
        return "0"
    if p == "-":
        return "–"
    return p


def load_fonts():
    return {
        "digit": ImageFont.truetype(FONT_BOLD, DIGIT_SIZE),
        "lyric": ImageFont.truetype(FONT_REG, LYRIC_SIZE),
        "title": ImageFont.truetype(FONT_BOLD, 36),
        "small": ImageFont.truetype(FONT_REG, 24),
        "acc": ImageFont.truetype(FONT_BOLD, 34),
    }


class Strip:
    def __init__(self, width, score, times, video_duration, title):
        self.W = width
        self.notes = score["notes"]
        self.bars = set(score.get("bars") or [])
        self.times = times
        self.n = len(self.notes)
        self.title = title
        self.key = score.get("key") or "C"
        self.fonts = load_fonts()
        self.last_end = min(video_duration, times[-1] + 1.25)
        self.max_scroll = max(0, MARGIN * 2 + self.n * SLOT - width)

        # 每个音在小节内的起拍位置，以及减时线左右是否与邻音相接。
        # 规则跟 notation.js 的 sameBeat 一致：同一拍内的八分/十六分音连成一条。
        self.start_beats = []
        beat = 0.0
        for i, note in enumerate(self.notes):
            if i in self.bars:
                beat = 0.0
            self.start_beats.append(beat)
            beat += float(note.get("beat") or 0)

        self.link_left = [False] * self.n
        self.link_right = [False] * self.n
        for i, note in enumerate(self.notes):
            if int(note.get("type") or 0) <= 0:
                continue
            if i > 0 and i not in self.bars and int(self.notes[i - 1].get("type") or 0) > 0:
                if math.floor(self.start_beats[i - 1] + 1e-9) == math.floor(self.start_beats[i] + 1e-9):
                    self.link_left[i] = True
            if i + 1 < self.n and (i + 1) not in self.bars and int(self.notes[i + 1].get("type") or 0) > 0:
                if math.floor(self.start_beats[i] + 1e-9) == math.floor(self.start_beats[i + 1] + 1e-9):
                    self.link_right[i] = True

    def x_center(self, i):
        return MARGIN + i * SLOT + SLOT / 2

    def scroll_at(self, t):
        k = bisect.bisect_right(self.times, t) - 1
        if k < 0:
            return 0.0
        k = min(k, self.n - 1)
        base = self.x_center(k) - self.W / 2
        if k + 1 < self.n:
            p = (t - self.times[k]) / max(1e-6, self.times[k + 1] - self.times[k])
            u = min(1.0, max(0.0, (p - 0.72) / 0.28))
            ease = u * u * (3 - 2 * u)
            base += (self.x_center(k + 1) - self.x_center(k)) * ease
        return min(max(base, 0.0), self.max_scroll)

    def progress_at(self, t):
        if t <= self.times[0]:
            return 0.0
        return min(1.0, max(0.0, (t - self.times[0]) / max(1e-6, self.last_end - self.times[0])))

    def current_at(self, t):
        k = bisect.bisect_right(self.times, t) - 1
        if k < 0 or k >= self.n:
            return -1
        if t > self.last_end:
            return -1
        return k

    def highlight_at(self, t, scroll):
        """当前高亮块的 (中心 x, 宽度)，以及被它盖住的音符索引。

        高亮块不是整块跳：在换音前的最后 `slide` 秒里，中心从当前音
        平滑推到下一个音，宽度同时从 102 撑到 184 再收回来。撑到最宽时
        会同时盖住两个数字，这就是「横跨两个数字」的那几帧。
        """
        cur = self.current_at(t)
        if cur < 0:
            return None, set()

        x_cur = self.x_center(cur) - scroll
        if cur + 1 >= self.n:
            return (x_cur, 102.0), {cur}

        x_next = self.x_center(cur + 1) - scroll
        interval = max(self.times[cur + 1] - self.times[cur], 1e-6)
        # 过渡时长：最长 0.24s，最多占这个音时长的 35%，至少 0.08s
        slide = min(0.24, max(0.08, interval * 0.35))
        start = self.times[cur + 1] - slide
        p = 0.0 if t <= start else min(1.0, (t - start) / slide)
        ease = p * p * (3 - 2 * p)

        center = x_cur + (x_next - x_cur) * ease
        # 保持原来的块宽 102px（x ± 51），不做任何变宽。
        # 滑动到中点时，块会压在两个数字的内侧边缘上，形成“横跨两个数字”的帧。
        width = 102.0

        active = set()
        for i in (cur, cur + 1):
            xi = self.x_center(i) - scroll
            # 51（块半宽）+ 18（数字字形半宽）：块碰到字形就点亮这个数字
            if abs(xi - center) <= width / 2 + 18:
                active.add(i)
        return (center, width), active

    def draw(self, t):
        W, H = self.W, STRIP_H
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, W, H], fill=(13, 12, 11, STRIP_ALPHA))
        d.rectangle([0, H - 2, W, H], fill=(255, 255, 255, 18))

        cur = self.current_at(t)
        scroll = self.scroll_at(t)
        block, active = self.highlight_at(t, scroll)

        # 标题 + 计数
        d.text((MARGIN, 12), self.title, font=self.fonts["title"], fill=(*INK, 245), anchor="la")
        title_w = d.textlength(self.title, font=self.fonts["title"])
        d.text((MARGIN + title_w + 18, 17), f"木琴 · {self.key} 调",
               font=self.fonts["small"], fill=(*MUTED, 230), anchor="la")
        if cur >= 0:
            counter = f"{cur + 1:02d} / {self.n}"
        elif t > self.last_end:
            counter = f"{self.n:02d} / {self.n}"
        else:
            counter = f"-- / {self.n}"
        d.text((W - MARGIN, 17), counter, font=self.fonts["small"], fill=(*MUTED, 230), anchor="ra")

        # 小节线
        for b in sorted(self.bars):
            if 0 < b <= self.n:
                bx = self.x_center(b - 1) + SLOT / 2 - scroll
                if -10 <= bx <= W + 10:
                    d.line([(bx, 52), (bx, 218)], fill=(190, 178, 164, 70), width=1)

        # 滑动高亮块：中心/宽度由 highlight_at 算，过渡时会撑宽盖住两个数字
        if block is not None:
            cx, bw = block
            left, right = cx - bw / 2, cx + bw / 2
            d.rounded_rectangle([left - 6, 56, right + 6, 218], radius=16,
                                fill=(*ACCENT, 48))
            d.rounded_rectangle([left, 62, right, 212], radius=13,
                                fill=(*ACCENT, 238))

        for i, note in enumerate(self.notes):
            x = self.x_center(i) - scroll
            # 只画窗口中完整的音；贴边的残片（尤其是长音的横杠）会像孤立的“-”
            if x < -10 or x > W + 10:
                continue
            ended = t > self.last_end
            if i in active:
                digit_color = (255, 255, 255, 255)
                lyric_color = (255, 255, 255, 255)
            elif ended or i <= cur:
                digit_color = (*PAST, 255)
                lyric_color = (*PAST, 235)
            else:
                digit_color = (*FUTURE, 245)
                lyric_color = (*FUTURE, 210)

            # 升降号
            acc = note.get("accidental") or ""
            if acc:
                glyph = {"#": "♯", "b": "♭", "n": "♮"}.get(acc[-1], acc)
                d.text((x - 30, 112), glyph, font=self.fonts["acc"], fill=digit_color, anchor="mm")

            # 数字
            d.text((x, 112), fmt_note(note), font=self.fonts["digit"], fill=digit_color, anchor="mm")

            # 八度点
            octv = note.get("octave") or 0
            if octv > 0:
                for k in range(octv):
                    d.ellipse([x - 4, 76 - k * 10, x + 4, 84 - k * 10], fill=digit_color)
            elif octv < 0:
                dot_y = 148 + int(note.get("type") or 0) * 7 + 6
                for k in range(-octv):
                    d.ellipse([x - 4, dot_y + k * 10, x + 4, dot_y + 8 + k * 10], fill=digit_color)

            # 减时线：八分画一条、十六分画两条；同一拍的音连成一条。
            # 线比数字窄/长一点，靠 link_left/link_right 与邻音接上。
            for k in range(int(note.get("type") or 0)):
                y = 148 + k * 7
                left = x - (SLOT / 2 if self.link_left[i] else 18)
                right = x + (SLOT / 2 if self.link_right[i] else 18)
                d.line([(left, y), (right, y)], fill=digit_color, width=4)

            # 增时线：mul=2 画一条短横，mul=3 画两条
            for k in range(max(0, int(note.get("mul", 1)) - 1)):
                d.line([(x + 22 + k * 18, 112), (x + 36 + k * 18, 112)], fill=digit_color, width=5)

            # 歌词
            lyric = note.get("lyric") or ""
            if lyric:
                d.text((x, 188), lyric, font=self.fonts["lyric"], fill=lyric_color, anchor="mm")

        # 进度条
        p = self.progress_at(t)
        d.rectangle([0, H - 16, W, H - 10], fill=(72, 63, 55, 210))
        d.rectangle([0, H - 16, int(W * p), H - 10], fill=(*ACCENT, 255))
        return img


def preview(args, strip, hdr):
    base_png = os.path.join(os.path.dirname(args.out) or ".", "_preview_base.png")
    vf = color_filter(hdr, "rgb24")
    run([args.ffmpeg, "-y", "-hide_banner", "-loglevel", "error",
         "-ss", str(args.preview_time), "-i", args.video, "-frames:v", "1",
         "-vf", vf, base_png])
    base = Image.open(base_png).convert("RGBA")
    strip_img = strip.draw(args.preview_time)
    if args.middle:
        y = max(0, (base.height - strip_img.height) // 2)
    else:
        y = max(0, args.top_offset)
    base.alpha_composite(strip_img, (0, y))
    base.convert("RGB").save(args.preview, quality=92)
    print(f"preview -> {args.preview}  (strip y={y})")


def render(args, strip, duration, hdr):
    W = strip.W
    total = int(math.ceil(duration * FPS))
    log_path = os.path.splitext(args.out)[0] + ".ffmpeg.log"
    if args.middle:
        overlay_y = "(main_h-overlay_h)/2"
    else:
        overlay_y = str(max(0, args.top_offset))
    vf = (f"[0:v]{color_filter(hdr, 'rgba')}[base];"
          f"[base][1:v]overlay=0:{overlay_y}:format=auto,format=yuv420p[out]")
    cmd = [
        args.ffmpeg, "-y", "-hide_banner", "-loglevel", "warning",
        "-i", args.video,
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{W}x{STRIP_H}",
        "-framerate", f"{FPS:.6f}", "-i", "pipe:0",
        "-filter_complex", vf,
        "-map", "[out]", "-map", "0:a?",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-r", f"{FPS:.6f}",
        "-c:a", "copy", "-t", f"{duration:.3f}",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
        "-movflags", "+faststart",
        "-map_metadata", "-1",
        args.out,
    ]
    print("ffmpeg:", " ".join(cmd[:8]), "...")
    with open(log_path, "w", encoding="utf-8") as log:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                stderr=log)
        try:
            for i in range(total):
                t = i / FPS
                frame = strip.draw(t)
                proc.stdin.write(frame.tobytes())
                if i % 60 == 0:
                    print(f"  frame {i}/{total}  t={t:.2f}s", flush=True)
        finally:
            proc.stdin.close()
            code = proc.wait()
    if code != 0:
        raise SystemExit(f"ffmpeg failed ({code}); see {log_path}")
    print(f"done -> {args.out}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--score", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--preview")
    ap.add_argument("--preview-time", type=float, default=5.0)
    ap.add_argument("--preview-only", action="store_true")
    ap.add_argument("--middle", action="store_true",
                    help="把字幕条放在画面垂直中间（避开手机顶部状态栏）")
    ap.add_argument("--top-offset", type=int, default=0,
                    help="字幕条距画面顶部的像素数；加 --middle 时忽略")
    ap.add_argument("--title", default=None, help="字幕条左上角的曲名，默认从 index.json 取")
    ap.add_argument("--robust", action="store_true",
                    help="强制使用小节锚点稳健对齐（默认仅在起音数不一致时启用）")
    ap.add_argument("--tolerance", type=float, default=0.35,
                    help="稳健对齐的匹配容差（秒）")
    ap.add_argument("--skip-penalty", type=float, default=0.75,
                    help="跳过锚点/起音的代价；越小越容易跳过")
    ap.add_argument("--bpm", type=float, default=None,
                    help="已知速度；用于未匹配小节的兜底时间")
    ap.add_argument("--export-map", default=None,
                    help="把 note_index -> 秒 的映射导出成 JSON，供网页播放器使用")
    ap.add_argument("--tonemap", choices=["auto", "on", "off"], default="auto",
                    help="HDR→SDR 色调映射：auto 按源色彩判断（默认），on 强制，off 关闭")
    ap.add_argument("--ffmpeg", default=shutil.which("ffmpeg") or r"D:\ycz\tools\ffmpeg\bin\ffmpeg.exe")
    ap.add_argument("--ffprobe", default=shutil.which("ffprobe") or r"D:\ycz\tools\ffmpeg\bin\ffprobe.exe")
    ap.add_argument("--node", default=shutil.which("node") or "node")
    args = ap.parse_args()

    if not os.path.exists(args.video):
        raise SystemExit(f"找不到视频：{args.video}")
    if args.top_offset < 0:
        raise SystemExit("--top-offset 不能为负数")
    if args.tolerance <= 0:
        raise SystemExit("--tolerance 必须大于 0")
    if args.skip_penalty < 0:
        raise SystemExit("--skip-penalty 不能为负数")
    if args.bpm is not None and args.bpm <= 0:
        raise SystemExit("--bpm 必须大于 0")
    if os.name == "nt" and args.out.startswith(("/", "\\")):
        raise SystemExit(
            f"输出路径以斜杠开头：{args.out}\n"
            "在 Windows 上它会解析到盘根目录（例如 C:\\media\\output\\...）。\n"
            "要写到项目里的 media/output，请写成 media/output/xxx.mp4。"
        )

    work = os.path.dirname(os.path.abspath(args.out))
    try:
        os.makedirs(work, exist_ok=True)
    except OSError as exc:
        raise SystemExit(f"创建输出目录失败：{work}\n{exc}")
    wav_path = os.path.join(work, "_audio.wav")

    score = load_score(args.node, args.score)
    print(f"score: {len(score['notes'])} notes, bars={score.get('bars')}")

    extract_wav(args.ffmpeg, args.video, wav_path)
    strong, all_peaks = detect_onsets(wav_path)
    print(f"onsets: {len(strong)} strong / {len(all_peaks)} total")
    times, align_info = align(
        strong,
        score,
        force_robust=args.robust,
        tolerance=args.tolerance,
        skip_penalty=args.skip_penalty,
        bpm=args.bpm,
    )
    print(f"align: {align_info['mode']} ({len(strong)} onsets / "
          f"{align_info.get('sounding', len(score['notes']))} sounding, "
          f"{len(score['notes'])} total notes)")
    if align_info.get("matched"):
        first = align_info["matched"][:4]
        print(f"anchors: {first}{' ...' if len(align_info['matched']) > 4 else ''}")
    duration = ffprobe_duration(args.ffprobe, args.video)
    print(f"duration: {duration:.3f}s; first={times[0]:.3f}s last={times[-1]:.3f}s")

    transfer, primaries, pix_fmt = ffprobe_color_info(args.ffprobe, args.video)
    if args.tonemap == "on":
        hdr = True
    elif args.tonemap == "off":
        hdr = False
    else:
        hdr = (transfer in ("arib-std-b67", "smpte2084")
               or (primaries == "bt2020" and (pix_fmt or "").endswith("10le")))
    print(f"color: {transfer or '?'} / {primaries or '?'} / {pix_fmt or '?'} "
          f"-> {'HDR tone map' if hdr else 'SDR passthrough'}")

    if args.export_map:
        map_path = args.export_map
        map_dir = os.path.dirname(os.path.abspath(map_path))
        os.makedirs(map_dir, exist_ok=True)
        payload = {str(i): round(float(t), 4) for i, t in enumerate(times)}
        with open(map_path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        print(f"map -> {map_path}")

    strip = Strip(1080, score, times, duration, args.title or lookup_title(args.score))
    print(f"strip: y={'middle' if args.middle else 'top'}, title={strip.title!r}")
    if args.preview:
        preview(args, strip, hdr)
    if args.out and not args.preview_only:
        render(args, strip, duration, hdr)


if __name__ == "__main__":
    main()
