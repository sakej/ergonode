#!/usr/bin/env python3
"""Generate a 1024x1024 app icon for the Ergonode Batch Uploader."""

from PIL import Image, ImageDraw
import math

SIZE = 1024
PRIMARY = (37, 99, 235)       # #2563eb
LIGHT_BG = (241, 245, 255)    # light blue-white
WHITE = (255, 255, 255)
SHADOW = (20, 60, 160, 40)

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# --- Rounded rectangle background ---
margin = 40
radius = 180
draw.rounded_rectangle(
    [margin, margin, SIZE - margin, SIZE - margin],
    radius=radius,
    fill=LIGHT_BG,
)

# Subtle inner border
draw.rounded_rectangle(
    [margin, margin, SIZE - margin, SIZE - margin],
    radius=radius,
    outline=(200, 215, 245),
    width=4,
)

# --- Cloud shape (composed of overlapping ellipses) ---
cx, cy = SIZE // 2, 460  # center of cloud area

# Cloud body ellipses (from left to right)
cloud_parts = [
    # (center_x_offset, center_y_offset, rx, ry)
    (-180, 20, 120, 100),   # left bump
    (-60, -40, 150, 130),   # left-center bump (taller)
    (80, -20, 140, 120),    # right-center bump
    (190, 30, 110, 90),     # right bump
]

# Flat bottom of cloud
cloud_bottom_y = cy + 80
cloud_left = cx - 300
cloud_right = cx + 300

# Draw cloud shadow first
shadow_offset = 12
shadow_img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
shadow_draw = ImageDraw.Draw(shadow_img)
for (ox, oy, rx, ry) in cloud_parts:
    shadow_draw.ellipse(
        [cx + ox - rx + shadow_offset, cy + oy - ry + shadow_offset,
         cx + ox + rx + shadow_offset, cy + oy + ry + shadow_offset],
        fill=(0, 0, 30, 30),
    )
shadow_draw.rectangle(
    [cloud_left + shadow_offset, cy + shadow_offset,
     cloud_right + shadow_offset, cloud_bottom_y + shadow_offset],
    fill=(0, 0, 30, 30),
)
img = Image.alpha_composite(img, shadow_img)
draw = ImageDraw.Draw(img)

# Draw cloud in white
for (ox, oy, rx, ry) in cloud_parts:
    draw.ellipse(
        [cx + ox - rx, cy + oy - ry, cx + ox + rx, cy + oy + ry],
        fill=WHITE,
    )
# Flat bottom rectangle to unify the cloud
draw.rectangle(
    [cloud_left, cy, cloud_right, cloud_bottom_y],
    fill=WHITE,
)

# --- Upload arrow (pointing up) ---
arrow_cx = cx
arrow_top = cy + 10
arrow_bottom = cy + 260
shaft_half_w = 38
head_half_w = 100
head_height = 120

# Arrow shaft
draw.rounded_rectangle(
    [arrow_cx - shaft_half_w, arrow_top + head_height - 20,
     arrow_cx + shaft_half_w, arrow_bottom],
    radius=20,
    fill=PRIMARY,
)

# Arrow head (triangle pointing up)
draw.polygon(
    [
        (arrow_cx, arrow_top),
        (arrow_cx - head_half_w, arrow_top + head_height),
        (arrow_cx + head_half_w, arrow_top + head_height),
    ],
    fill=PRIMARY,
)

# --- Three small horizontal lines at the bottom to suggest "batch/stack" ---
line_y_start = 700
line_spacing = 55
line_lengths = [260, 200, 140]
line_h = 18
line_radius = 9

for i, length in enumerate(line_lengths):
    ly = line_y_start + i * line_spacing
    draw.rounded_rectangle(
        [cx - length // 2, ly, cx + length // 2, ly + line_h],
        radius=line_radius,
        fill=PRIMARY,
    )

# Save
out_path = "/Users/marcinkrasicki/Documents/MY_APPS/Batch image uploaded (Ergonode)/app-icon.png"
img.save(out_path, "PNG")
print(f"Icon saved to {out_path}")
