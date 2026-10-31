import cv2
import numpy as np
import math
import json

def detect_by_real_physics(image_path):
    img = cv2.imread(image_path)
    if img is None:
        print("❌ 找不到图片")
        return
    output_img = img.copy()
    height, width = img.shape[:2]

    # ================= 1. 物理数据 =================
    total_lens = [16.2, 15.3, 14.4, 14.0, 13.2, 12.4, 12.1, 11.3, 10.6, 10.0, 9.8, 9.2, 8.7, 8.4, 7.9]
    dot_spacings_cm = np.linspace(9.0, 4.0, 15)

    # ================= 2. 找绿点 =================
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, np.array([35, 100, 100]), np.array([85, 255, 255]))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    raw_dots = []
    for cnt in contours:
        if 30 < cv2.contourArea(cnt) < 3000: 
            M = cv2.moments(cnt)
            if M["m00"] != 0:
                raw_dots.append({"x": int(M["m10"] / M["m00"]), "y": int(M["m01"] / M["m00"])})

    y_threshold = height * 0.80
    top_raw = sorted([p for p in raw_dots if p["y"] < y_threshold], key=lambda p: p["x"])
    bottom_raw = sorted([p for p in raw_dots if p["y"] >= y_threshold], key=lambda p: p["x"])

    def fit_line_15(dots):
        if len(dots) < 2: return []
        xs = np.array([p["x"] for p in dots])
        ys = np.array([p["y"] for p in dots])
        k, b = np.polyfit(xs, ys, 1)
        min_x, max_x = min(xs), max(xs)
        step_x = (max_x - min_x) / 14.0
        
        res = []
        for i in range(15):
            target_x = min_x + step_x * i
            target_y = int(k * target_x + b)
            closest = None
            for p in dots:
                if abs(p["x"] - target_x) < (step_x / 2.5):
                    closest = p
                    break
            if closest: res.append({"x": closest["x"], "y": closest["y"]})
            else: res.append({"x": int(target_x), "y": target_y})
        return res

    top_dots = fit_line_15(top_raw)
    bottom_dots = fit_line_15(bottom_raw)

    # ================= 3. 计算精确透视参数 =================
    # 取中间第 8 根琴键作为比例尺基准
    idx_ref = 7
    t_ref = top_dots[idx_ref]
    b_ref = bottom_dots[idx_ref]
    
    # 算两个绿点之间的像素距离
    px_dist = math.sqrt((b_ref["x"] - t_ref["x"])**2 + (b_ref["y"] - t_ref["y"])**2)
    # 1 cm 等于多少像素
    px_per_cm = px_dist / dot_spacings_cm[idx_ref]

    # 由你的观察：因为透视，下方看起来更长
    # 上半段（绿点到顶）按 40% 算，下半段（绿点到底）按 60% 算
    top_ratio = 0.40
    bottom_ratio = 0.60

    keys_data = []

    for i in range(15):
        t_dot = top_dots[i]
        b_dot = bottom_dots[i]
        
        # 物理高度转像素高度
        total_px_h = total_lens[i] * px_per_cm
        ext_top_px = total_px_h * top_ratio
        ext_bot_px = total_px_h * bottom_ratio
        
        # 得出上下边缘的绝对 Y 坐标（绝对水平）
        top_y = int(t_dot["y"] - ext_top_px)
        bottom_y = int(b_dot["y"] + ext_bot_px)

        # X 坐标：以绿点为中轴线
        # 算出一个合适的像素宽度（取相邻琴键中心间距的 90% 左右，刚好卡在缝里）
        if i < 14:
            width_px = (top_dots[i+1]["x"] - top_dots[i]["x"]) * 0.9
        else:
            width_px = (top_dots[i]["x"] - top_dots[i-1]["x"]) * 0.9
        half_w = width_px / 2

        # 计算倾斜偏移量（上排绿点和下排绿点在 X 轴上的错位）
        # 这样可以保证左右边缘是顺着琴键倾斜的斜线
        dx_tilt = b_dot["x"] - t_dot["x"]

        polygon = [
            [int(t_dot["x"] - half_w), top_y],                 # 左上
            [int(t_dot["x"] + half_w), top_y],                 # 右上
            [int(b_dot["x"] + half_w), bottom_y],              # 右下
            [int(b_dot["x"] - half_w), bottom_y]               # 左下
        ]

        # 取色
        cx = int((t_dot["x"] + b_dot["x"]) / 2)
        cy = int((top_y + bottom_y) / 2)
        roi_color = img[max(0, cy-5):cy+5, max(0, cx-5):cx+5]
        avg_color = np.mean(roi_color.reshape(-1, 3), axis=0) if roi_color.size > 0 else [255, 255, 255]
        color_hex = '#{:02x}{:02x}{:02x}'.format(int(avg_color[2]), int(avg_color[1]), int(avg_color[0]))

        keys_data.append({
            "id": f"key_{i+1}",
            "points": polygon,
            "center": [cx, cy],
            "color": color_hex
        })

        # 绘制
        cv2.polylines(output_img, [np.array(polygon)], True, (0, 255, 0), 2)
        cv2.circle(output_img, (t_dot["x"], t_dot["y"]), 4, (0, 0, 255), -1)
        cv2.circle(output_img, (b_dot["x"], b_dot["y"]), 4, (0, 0, 255), -1)

    cv2.imwrite("detect_result_final_physics.jpg", output_img)
    with open("keys_data.json", "w", encoding="utf-8") as f:
        json.dump(keys_data, f, indent=4)
    print("✅ 终极物理贴合完成！请查看 'detect_result_final_physics.jpg'。")

if __name__ == "__main__":
    detect_by_real_physics("frame.jpg")