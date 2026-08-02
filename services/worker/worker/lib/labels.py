"""CLIP zero-shot label set (~120 labels, SPEC §6.1.5) incl. Indian-context labels."""

LABELS: list[str] = [
    # people
    "portrait of a person", "group of friends", "family gathering", "selfie",
    "children playing", "baby", "couple", "crowd of people", "dancer", "musician",
    # scenes / places
    "beach", "mountains", "forest", "waterfall", "lake", "river", "desert",
    "city skyline", "street scene", "sunset", "sunrise", "night sky", "clouds",
    "garden", "park", "temple", "church", "mosque", "palace", "fort", "monument",
    "village", "farmland", "snow", "rain", "road trip", "airport", "railway station",
    # activities
    "wedding ceremony", "birthday party", "concert", "sports game", "cricket match",
    "football match", "yoga", "swimming", "hiking", "camping", "cycling", "running",
    "cooking", "shopping", "picnic", "boat ride", "amusement park", "fireworks",
    "graduation ceremony", "office meeting", "workout at gym", "dancing at a party",
    # food
    "plate of food", "street food", "dessert", "cake", "coffee", "tea",
    "biryani", "dosa", "thali meal", "sweets and mithai", "fruit",
    # festivals & Indian context
    "diwali celebration", "holi festival colors", "mehndi on hands", "haldi ceremony",
    "rangoli decoration", "diya oil lamp", "garba dance", "durga puja", "ganesh idol",
    "christmas tree", "new year celebration", "eid celebration", "sangeet night",
    "baraat procession", "temple ritual", "aarti ceremony", "kite flying",
    # objects / products
    "product photo", "cosmetics product", "clothing and fashion", "jewelry",
    "shoes", "watch", "smartphone", "laptop", "car", "motorcycle", "bicycle",
    "furniture", "home interior", "handicraft", "packaged food product",
    # animals & nature
    "dog", "cat", "bird", "elephant", "horse", "cow", "flowers", "trees",
    # media styles
    "screenshot of text", "document photo", "whiteboard notes", "meme image",
    "logo design", "poster design", "landscape photography", "macro photography",
    "aerial drone shot", "underwater photo", "black and white photo",
]

assert len(LABELS) >= 100, "keep the label set rich (SPEC asks ~120)"

# Vibe affinity priors: which labels boost selection for a vibe (SPEC §6.4.4 aesthetic prior)
VIBE_LABEL_AFFINITY: dict[str, list[str]] = {
    "travel-cinematic": [
        "beach", "mountains", "forest", "waterfall", "lake", "river", "city skyline",
        "sunset", "sunrise", "landscape photography", "aerial drone shot", "road trip",
        "temple", "monument", "fort", "palace", "hiking", "camping", "boat ride",
    ],
    "birthday-fun": [
        "birthday party", "cake", "children playing", "group of friends", "balloons",
        "dessert", "dancing at a party", "fireworks", "selfie", "family gathering",
    ],
    "product-promo": [
        "product photo", "cosmetics product", "clothing and fashion", "jewelry",
        "shoes", "watch", "smartphone", "laptop", "packaged food product",
        "handicraft", "furniture", "logo design",
    ],
}
