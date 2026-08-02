"""ASS subtitle generation — text clips + karaoke captions (SPEC §6.6.3).

One .ass file carries both: text clips as positioned dialogue with fade/pop
via override tags, captions as \\k karaoke word timings. Styles keyed by styleId.
"""

from __future__ import annotations

# styleId -> (fontname, fontsize/1080p, primary &HAABBGGRR, bold, italic, outline)
STYLES: dict[str, dict] = {
    "title-bold": {"font": "Noto Sans", "size": 72, "color": "&H00FFFFFF", "bold": -1,
                   "italic": 0, "outline": 3},
    "title-serif-white": {"font": "Noto Serif", "size": 68, "color": "&H00FFFFFF", "bold": 0,
                          "italic": 0, "outline": 2},
    "pop-bold-yellow": {"font": "Noto Sans", "size": 76, "color": "&H0000E5FF", "bold": -1,
                        "italic": 0, "outline": 3},
    "clean-sans-brand": {"font": "Noto Sans", "size": 60, "color": "&H00F5F0EA", "bold": 0,
                         "italic": 0, "outline": 2},
    "karaoke-yellow": {"font": "Noto Sans", "size": 54, "color": "&H00FFFFFF", "bold": -1,
                       "italic": 0, "outline": 2, "secondary": "&H0000E5FF"},
    "karaoke-clean": {"font": "Noto Sans", "size": 52, "color": "&H00FFFFFF", "bold": 0,
                      "italic": 0, "outline": 2, "secondary": "&H00FFD070"},
}

POS_ALIGN = {"center": 5, "lower": 2, "upper": 8}  # ASS numpad alignment


def _ts(seconds: float) -> str:
    seconds = max(0.0, seconds)
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def _style_line(name: str, cfg: dict, scale: float) -> str:
    size = max(10, int(cfg["size"] * scale))
    secondary = cfg.get("secondary", "&H000000FF")
    outline = max(1, int(cfg["outline"] * scale))
    return (
        f"Style: {name},{cfg['font']},{size},{cfg['color']},{secondary},"
        f"&H00101010,&H80000000,{cfg['bold']},{cfg['italic']},0,0,100,100,0,0,1,"
        f"{outline},0,2,40,40,60,1"
    )


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("{", "(").replace("}", ")").replace("\n", "\\N")


def build_ass(
    width: int,
    height: int,
    text_clips: list[dict],
    captions: dict | None = None,
) -> str:
    """Render an .ass document for the given §5.1 text clips + captions block."""
    scale = height / 1920.0  # style sizes are tuned for 1080x1920

    used_styles = {clip.get("styleId", "title-bold") for clip in text_clips}
    captions = captions or {}
    caption_style = captions.get("styleId", "karaoke-yellow")
    if captions.get("enabled") and captions.get("words"):
        used_styles.add(caption_style)

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ]
    for name in sorted(used_styles):
        cfg = STYLES.get(name, STYLES["title-bold"])
        lines.append(_style_line(name, cfg, scale))
    lines += [
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    for clip in sorted(text_clips, key=lambda c: (c.get("start", 0), c.get("id", ""))):
        style = clip.get("styleId", "title-bold")
        if style not in STYLES:
            style = "title-bold"
        align = POS_ALIGN.get(clip.get("pos", "center"), 5)
        animate = clip.get("animate", "none")
        tags = f"\\an{align}"
        if animate == "fade":
            tags += "\\fad(250,250)"
        elif animate == "pop":
            tags += "\\fscx60\\fscy60\\t(0,180,\\fscx100\\fscy100)\\fad(80,120)"
        text = _escape(clip.get("text", ""))
        lines.append(
            f"Dialogue: 0,{_ts(clip['start'])},{_ts(clip['end'])},{style},,0,0,0,,"
            f"{{{tags}}}{text}"
        )

    if captions.get("enabled") and captions.get("words"):
        words = captions["words"]
        # group words into caption lines of <=5 words / <=3.5 s
        group: list[dict] = []
        groups: list[list[dict]] = []
        for word in words:
            if group and (len(group) >= 5 or word["e"] - group[0]["s"] > 3.5):
                groups.append(group)
                group = []
            group.append(word)
        if group:
            groups.append(group)
        for grp in groups:
            start, end = grp[0]["s"], grp[-1]["e"]
            parts = []
            for word in grp:
                dur_cs = max(1, int(round((word["e"] - word["s"]) * 100)))
                parts.append(f"{{\\k{dur_cs}}}{_escape(word['w'])}")
            lines.append(
                f"Dialogue: 0,{_ts(start)},{_ts(end)},{caption_style},,0,0,0,,"
                f"{{\\an2}}{' '.join(parts)}"
            )

    return "\n".join(lines) + "\n"
