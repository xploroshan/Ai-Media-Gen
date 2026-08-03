"""P4 exit tests — .ass generation snapshots (en + hi) and ducking windows."""


from worker.lib.ass import build_ass
from worker.lib.ducking import duck_volume_filter, speech_windows

EN_WORDS = [
    {"w": "hello", "s": 0.5, "e": 0.9},
    {"w": "world", "s": 0.95, "e": 1.4},
    {"w": "welcome", "s": 2.1, "e": 2.6},
    {"w": "to", "s": 2.65, "e": 2.8},
    {"w": "ReelForge", "s": 2.85, "e": 3.5},
    {"w": "captions", "s": 3.55, "e": 4.1},
]

HI_WORDS = [
    {"w": "नमस्ते", "s": 0.4, "e": 1.0},
    {"w": "दुनिया", "s": 1.1, "e": 1.7},
    {"w": "रीलफोर्ज", "s": 2.0, "e": 2.8},
    {"w": "में", "s": 2.85, "e": 3.0},
    {"w": "आपका", "s": 3.05, "e": 3.4},
    {"w": "स्वागत", "s": 3.45, "e": 3.9},
    {"w": "है", "s": 3.95, "e": 4.1},
]

EXPECTED_EN = """[Script Info]
ScriptType: v4.00+
PlayResX: 540
PlayResY: 960
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: karaoke-yellow,Noto Sans,27,&H00FFFFFF,&H0000E5FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,1,0,2,40,40,60,1
Style: title-bold,Noto Sans,36,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,1,0,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:02.20,title-bold,,0,0,0,,{\\an5\\fscx60\\fscy60\\t(0,180,\\fscx100\\fscy100)\\fad(80,120)}Beach Day
Dialogue: 0,0:00:00.50,0:00:03.50,karaoke-yellow,,0,0,0,,{\\an2}{\\k40}hello {\\k5} {\\k45}world {\\k70} {\\k50}welcome {\\k5} {\\k15}to {\\k5} {\\k65}ReelForge
Dialogue: 0,0:00:03.55,0:00:04.10,karaoke-yellow,,0,0,0,,{\\an2}{\\k55}captions
"""

EXPECTED_HI = """[Script Info]
ScriptType: v4.00+
PlayResX: 540
PlayResY: 960
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: karaoke-yellow,Noto Sans,27,&H00FFFFFF,&H0000E5FF,&H00101010,&H80000000,-1,0,0,0,100,100,0,0,1,1,0,2,40,40,60,1
Style: title-serif-white,Noto Serif,34,&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,40,40,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,title-serif-white,,0,0,0,,{\\an8\\fad(250,250)}गोवा यात्रा
Dialogue: 0,0:00:00.40,0:00:03.40,karaoke-yellow,,0,0,0,,{\\an2}{\\k60}नमस्ते {\\k10} {\\k60}दुनिया {\\k30} {\\k80}रीलफोर्ज {\\k5} {\\k15}में {\\k5} {\\k35}आपका
Dialogue: 0,0:00:03.45,0:00:04.10,karaoke-yellow,,0,0,0,,{\\an2}{\\k45}स्वागत {\\k5} {\\k15}है
"""


class TestAssSnapshots:
    def test_english_snapshot(self):
        out = build_ass(
            540,
            960,
            [
                {
                    "id": "t1", "text": "Beach Day", "start": 0.2, "end": 2.2,
                    "styleId": "title-bold", "pos": "center", "animate": "pop",
                }
            ],
            {"enabled": True, "styleId": "karaoke-yellow", "lang": "en", "words": EN_WORDS},
        )
        assert out == EXPECTED_EN

    def test_hindi_devanagari_snapshot(self):
        out = build_ass(
            540,
            960,
            [
                {
                    "id": "t1", "text": "गोवा यात्रा", "start": 0.0, "end": 2.0,
                    "styleId": "title-serif-white", "pos": "upper", "animate": "fade",
                }
            ],
            {"enabled": True, "styleId": "karaoke-yellow", "lang": "hi", "words": HI_WORDS},
        )
        assert out == EXPECTED_HI
        assert "Style: title-serif-white,Noto Serif" in out
        # stable golden shape: same input twice → identical output
        again = build_ass(
            540,
            960,
            [
                {
                    "id": "t1", "text": "गोवा यात्रा", "start": 0.0, "end": 2.0,
                    "styleId": "title-serif-white", "pos": "upper", "animate": "fade",
                }
            ],
            {"enabled": True, "styleId": "karaoke-yellow", "lang": "hi", "words": HI_WORDS},
        )
        assert out == again

    def test_karaoke_line_grouping(self):
        # 12 words -> lines of <=5 words
        words = [{"w": f"w{i}", "s": i * 0.5, "e": i * 0.5 + 0.4} for i in range(12)]
        out = build_ass(540, 960, [], {"enabled": True, "styleId": "karaoke-yellow",
                                       "lang": "en", "words": words})
        karaoke_lines = [ln for ln in out.splitlines() if "\\k" in ln]
        assert len(karaoke_lines) == 3  # 5 + 5 + 2

    def test_braces_escaped(self):
        out = build_ass(540, 960, [{"id": "t", "text": "a{b}c", "start": 0, "end": 1,
                                    "styleId": "title-bold"}], None)
        assert "{b}" not in out.split("Dialogue")[1]
        assert "a(b)c" in out

    def test_unknown_style_falls_back(self):
        out = build_ass(540, 960, [{"id": "t", "text": "x", "start": 0, "end": 1,
                                    "styleId": "no-such-style"}], None)
        assert "Style: no-such-style,Noto Sans" in out  # rendered with fallback cfg


class TestDucking:
    def test_windows_merge_close_words(self):
        wins = speech_windows(EN_WORDS)
        # hello+world merge (gap 0.05), welcome..captions merge into one window
        assert wins == [(0.5, 1.4), (2.1, 4.1)]

    def test_windows_drop_tiny(self):
        assert speech_windows([{"w": "x", "s": 1.0, "e": 1.05}]) == []

    def test_filter_string(self):
        f = duck_volume_filter([(0.5, 1.4), (2.1, 4.1)], -10)
        assert f == "volume=volume=-10.0dB:enable='between(t,0.500,1.400)+between(t,2.100,4.100)'"

    def test_no_windows_no_filter(self):
        assert duck_volume_filter([], -10) is None
        assert duck_volume_filter([(0, 1)], 0) is None

    def test_many_windows_coalesce(self):
        words = [{"w": "x", "s": i * 2.0, "e": i * 2.0 + 0.5} for i in range(120)]
        wins = speech_windows(words)
        assert len(wins) <= 40
