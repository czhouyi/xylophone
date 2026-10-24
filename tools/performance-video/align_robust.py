"""
align_robust.py — 抗漏音/杂音的小节锚点对齐。

和逐音符强制 DTW 的区别：
  1. 只对齐「每个小节的第一个音」这些锚点，锚点之间允许跳过；
  2. 匹配代价超过 skip_penalty 时，算法宁可跳过这个锚点/这个起音，
     而不是硬把它俩配在一起（漏敲、多敲、卡顿就不会把后面全带偏）；
  3. 锚点对好后，小节内部按拍数做线性插值，局部速度由相邻锚点决定，
     所以中间某个音弹错/漏弹，只影响当前小节内部，不会污染下一小节。

输入：
  onset_times: 一维 numpy 数组，librosa 检测到的敲击时间（秒），可含杂音
  score_data:  [{"note": "1", "duration": 1.0, "is_measure_start": True}, ...]
               duration 是拍数；is_measure_start 标记小节第一个音

输出：
  {note_index: audio_time}    每个音符对应的视频时间（秒）
  如果 return_debug=True，返回 (mapping, debug)，debug 里有锚点匹配详情。
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np


def align_score_to_onsets(
    onset_times: Any,
    score_data: list[dict[str, Any]],
    *,
    bpm: float | None = None,
    tolerance: float = 0.35,
    skip_penalty: float = 0.75,
    max_cost: float = 8.0,
    return_debug: bool = False,
):
    """把起音序列稳健地对到简谱音符上。

    参数
    ----
    bpm:
        已知速度时传入（拍/分钟），用于推算未匹配小节的绝对时间；
        不传就用「第一个起音 → 最后一个起音」的总跨度估一个全局速度。
    tolerance:
        匹配代价的尺度（秒）。偏离 tolerance 秒，代价约为 1。
    skip_penalty:
        跳过一个锚点或一个起音的代价。代价 > skip_penalty 时，DP 会选择跳过。
        调大 → 更不愿意跳过（更容易强行对齐）；调小 → 更愿意跳过。
    max_cost:
        单次匹配代价的上限，避免一个离谱的起音把整张矩阵拉爆。
    return_debug:
        为 True 时额外返回锚点匹配信息，便于调参。
    """
    times = np.asarray(onset_times, dtype=float).ravel()
    times = times[np.isfinite(times)]
    times.sort()
    if times.size == 0:
        raise ValueError("onset_times 为空：没有可对齐的起音")
    if not score_data:
        return ({}, {}) if return_debug else {}

    n = len(score_data)
    durations = np.array(
        [max(float(item.get("duration", 1.0) or 1.0), 1e-3) for item in score_data],
        dtype=float,
    )
    # starts[i] = 第 i 个音符在小节/全曲里的起拍位置（单位：拍）
    starts = np.zeros(n, dtype=float)
    if n > 1:
        starts[1:] = np.cumsum(durations)[:-1]
    total_beats = float(starts[-1] + durations[-1])

    # 最后一个音符只有起点、没有下一个起音，所以「起音跨度」对应的是
    # 第一个音到最后一个音起点之间的拍数：total_beats - 最后一个音的时值。
    span_beats = max(total_beats - float(durations[-1]), 1e-6)

    t0, t1 = float(times[0]), float(times[-1])
    span_sec = max(t1 - t0, 1e-6)

    # 全局速度：只在没有锚点、或锚点之外的地方做兜底插值时使用。
    if bpm is not None and bpm > 0:
        sec_per_beat = 60.0 / float(bpm)
    else:
        sec_per_beat = span_sec / span_beats
        sec_per_beat = float(np.clip(sec_per_beat, 0.15, 2.0))

    # ---------- 1. 取小节首音作为锚点 ----------
    anchors = [i for i, item in enumerate(score_data) if item.get("is_measure_start")]
    if not anchors or anchors[0] != 0:
        anchors.insert(0, 0)  # 第一小节必须有一个起点
    anchors = sorted(set(anchors))
    anchor_count = len(anchors)

    # 锚点在「起拍位置」上的比例。用 span_beats 而不是 total_beats，
    # 这样最后一个锚点刚好落在最后一个起音附近时，代价是 0。
    anchor_frac = np.array([starts[a] / span_beats for a in anchors], dtype=float)

    # ---------- 2. 带跳过惩罚的锚点序列对齐 ----------
    # 匹配代价用「归一化位置差 × 总秒数 / tolerance」的平方：
    #   - 位置用比例算，演奏整体偏快/偏慢不会产生系统性误差；
    #   - 偏离 0.35s 左右代价约 1，超过 skip_penalty 就会被跳过。
    def match_cost(ai: int, oj: int) -> float:
        audio_frac = (times[oj] - t0) / span_sec
        diff_sec = abs(anchor_frac[ai] - audio_frac) * span_sec
        return min((diff_sec / max(tolerance, 1e-6)) ** 2, max_cost)

    # D[i, j]：前 i 个锚点与前 j 个起音的最小代价。
    # 三个转移：
    #   匹配       D[i-1, j-1] + match_cost(i-1, j-1)
    #   跳过锚点   D[i-1, j]   + skip_penalty
    #   跳过起音   D[i, j-1]   + skip_penalty
    inf = float("inf")
    D = np.full((anchor_count + 1, times.size + 1), inf, dtype=float)
    D[0, 0] = 0.0
    for i in range(1, anchor_count + 1):
        D[i, 0] = D[i - 1, 0] + skip_penalty
    for j in range(1, times.size + 1):
        D[0, j] = D[0, j - 1] + skip_penalty

    for i in range(1, anchor_count + 1):
        for j in range(1, times.size + 1):
            cost = match_cost(i - 1, j - 1)
            D[i, j] = min(
                D[i - 1, j - 1] + cost,       # 匹配
                D[i - 1, j] + skip_penalty,   # 这个锚点没弹（漏小节/漏音）
                D[i, j - 1] + skip_penalty,   # 这个起音是杂音/多敲
            )

    # 回溯：优先走匹配，其次跳过锚点，再跳过起音
    matched: list[tuple[int, int]] = []
    i, j = anchor_count, times.size
    while i > 0 or j > 0:
        if i > 0 and j > 0:
            cost = match_cost(i - 1, j - 1)
            if abs(D[i, j] - (D[i - 1, j - 1] + cost)) < 1e-9:
                matched.append((i - 1, j - 1))
                i -= 1
                j -= 1
                continue
        if i > 0 and abs(D[i, j] - (D[i - 1, j] + skip_penalty)) < 1e-9:
            i -= 1
            continue
        if j > 0 and abs(D[i, j] - (D[i, j - 1] + skip_penalty)) < 1e-9:
            j -= 1
            continue
        # 浮点误差兜底，避免死循环
        if i > 0:
            i -= 1
        elif j > 0:
            j -= 1
    matched.reverse()

    # ---------- 3. 给每个锚点一个绝对时间 ----------
    anchor_times = np.full(anchor_count, np.nan, dtype=float)
    for ai, oj in matched:
        anchor_times[ai] = float(times[oj])

    matched_ai = [ai for ai, _ in matched]

    if not matched_ai:
        # 一个锚点都没配上：退化成整首的线性映射，至少保证单调。
        mapping = {}
        for k in range(n):
            frac = min(max(starts[k] / span_beats, 0.0), 1.0)
            mapping[k] = float(t0 + frac * span_sec)
        debug = {"matched": [], "anchor_times": anchor_times.tolist(),
                 "sec_per_beat": sec_per_beat}
        return (mapping, debug) if return_debug else mapping

    # 没有匹配上的锚点：
    #   - 前后都有匹配锚点 → 按拍位置在两者之间线性插值（整段漏弹也能平滑过渡）
    #   - 只有后面有       → 用全局速度往前外推
    #   - 只有前面有       → 用全局速度往后外推
    for ai in range(anchor_count):
        if not np.isnan(anchor_times[ai]):
            continue
        prev = [m for m in matched_ai if m < ai]
        nxt = [m for m in matched_ai if m > ai]
        if prev and nxt:
            p, q = prev[-1], nxt[0]
            beat_span = max(starts[anchors[q]] - starts[anchors[p]], 1e-6)
            frac = (starts[anchors[ai]] - starts[anchors[p]]) / beat_span
            anchor_times[ai] = anchor_times[p] + frac * (anchor_times[q] - anchor_times[p])
        elif nxt:
            q = nxt[0]
            beats_back = starts[anchors[q]] - starts[anchors[ai]]
            anchor_times[ai] = anchor_times[q] - beats_back * sec_per_beat
        else:
            p = prev[-1]
            beats_forward = starts[anchors[ai]] - starts[anchors[p]]
            anchor_times[ai] = anchor_times[p] + beats_forward * sec_per_beat

    # 外推可能到负数；单调化，保证时间不倒流
    anchor_times = np.maximum(anchor_times, 0.0)
    anchor_times = np.maximum.accumulate(anchor_times)

    # ---------- 4. 小节内部：按拍数线性插值 ----------
    # 每一段的局部速度 = (下一个锚点时间 - 当前锚点时间) / 这一段的总拍数。
    # 注意：这里刻意不逐音符看 onset —— 小节内部弹错/漏音只影响这一小节，
    # 不会改变锚点，所以下一小节仍然从正确的位置开始。
    mapping: dict[int, float] = {}
    for mi, start_note in enumerate(anchors):
        end_note = anchors[mi + 1] if mi + 1 < anchor_count else n
        b_start = starts[start_note]
        b_end = starts[end_note] if end_note < n else total_beats
        beat_span = max(b_end - b_start, 1e-6)

        if mi + 1 < anchor_count:
            local_spb = (anchor_times[mi + 1] - anchor_times[mi]) / beat_span
            if not math.isfinite(local_spb) or local_spb <= 0:
                local_spb = sec_per_beat
        else:
            local_spb = sec_per_beat

        for k in range(start_note, end_note):
            t = anchor_times[mi] + (starts[k] - b_start) * local_spb
            mapping[k] = max(float(t), 0.0)

    # 再兜一层单调，避免极端插值造成倒流
    last = 0.0
    for k in range(n):
        if k not in mapping:
            mapping[k] = last
        mapping[k] = max(mapping[k], last)
        last = mapping[k]

    debug = {
        "matched": [(anchors[ai], float(times[oj])) for ai, oj in matched],
        "anchor_times": anchor_times.tolist(),
        "sec_per_beat": sec_per_beat,
        "tolerance": tolerance,
        "skip_penalty": skip_penalty,
    }
    return (mapping, debug) if return_debug else mapping


if __name__ == "__main__":
    # 一个很小的自测：8 个音、2 小节，人为插入一个杂音、漏掉一个音。
    score = [
        {"note": "1", "duration": 1.0, "is_measure_start": True},
        {"note": "2", "duration": 1.0, "is_measure_start": False},
        {"note": "3", "duration": 1.0, "is_measure_start": False},
        {"note": "4", "duration": 1.0, "is_measure_start": False},
        {"note": "5", "duration": 1.0, "is_measure_start": True},
        {"note": "6", "duration": 1.0, "is_measure_start": False},
        {"note": "7", "duration": 1.0, "is_measure_start": False},
        {"note": "1", "duration": 1.0, "is_measure_start": False},
    ]
    onsets = np.array([0.0, 0.52, 1.01, 1.50, 2.02,
                       2.48, 3.01, 3.52, 4.01])
    mapping, debug = align_score_to_onsets(onsets, score, return_debug=True)
    print("mapping:", {k: round(v, 3) for k, v in mapping.items()})
    print("anchors:", debug["matched"])
