"""Reference layout of the Makkha Health & Spa intake form (template ``makkha-intake-v1``).

Every coordinate is in *reference pixels* of an 805x569 scan (calibrated on tests/fixtures/sample2.png).
Other image sizes are resized to the reference size for deterministic analysis. The printed geometry of a scan is fitted
to these coordinates (``ocr_register``: scale, rotation, shift) and every region is placed through that fit; model crops
are cut from the original image through the same fit (coordinates scaled by width/805 and height/569).
"""

REF_W, REF_H = 805, 569
TEMPLATE = "makkha-intake-v1"
ASPECT_TOLERANCE = 0.03

# Checkbox outer squares: (key, printed English label, x, y, size). The printed border is ~2px wide.
CHECKBOXES = {
    "gender": [
        ("male", "Male", 106, 104, 13), ("female", "Female", 190, 104, 13), ("other", "Other", 277, 104, 13),
    ],
    "referralSources": [
        ("google", "Google", 34, 230, 12), ("klook", "Klook", 168, 229, 12), ("redBook", "Red Book", 277, 229, 12),
        ("daZhongDianPing", "Da Zhong Dian Ping", 34, 250, 12), ("signage", "Signage", 168, 250, 12), ("kkday", "Kkday", 277, 250, 12),
        ("totoBookingMonkeyTravel", "ToTo Booking / Monkey Travel", 34, 270, 12), ("tripadvisor", "Tripadvisor", 168, 270, 12),
        ("hotelStaff", "Hotel Staff", 277, 270, 12),
        ("tourGuide", "Tour Guide", 34, 291, 12), ("brochures", "Brochures", 168, 290, 12), ("others", "Others", 277, 290, 12),
    ],
    "healthConditions": [
        ("heartDisease", "Heart disease", 34, 365, 12), ("pregnancy", "Pregnancy", 194, 364, 12),
        ("cancer", "Cancer", 34, 382, 12), ("menstruation", "Menstruation", 194, 382, 12),
        ("highBloodPressure", "High blood pressure", 34, 400, 12), ("infectiousSkinDisease", "Infectious skin disease", 194, 400, 12),
        ("diabetes", "Diabetes", 34, 418, 12), ("haveACold", "Have a cold", 194, 417, 12),
        ("shoulderOrBackPain", "Shoulder or back pain", 34, 435, 12), ("claustrophobia", "Claustrophobia", 194, 435, 12),
        ("jointOrBoneDisorder", "Joint or bone disorder", 34, 453, 12), ("anyAllergies", "Any allergies and reactions", 194, 453, 12),
        ("asthma", "Asthma", 34, 471, 12), ("sle", "Systemic Lupus Erythematosus (SLE)", 194, 470, 12),
        ("healingInjuriesOrRecentSurgery", "Have healing injuries or recent surgery", 34, 488, 12),
        ("others", "Others", 34, 506, 12),
    ],
    "pressure": [
        ("strong", "Strong", 525, 76, 12), ("standard", "Standard", 615, 76, 12), ("soft", "Soft", 699, 76, 12),
    ],
    "massageOilScrub": [
        ("jasmine", "Jasmine", 525, 98, 12), ("rose", "Rose", 615, 98, 12), ("citronella", "Citronella", 690, 98, 12),
        ("orangeCinnamon", "Orange-Cinnamon", 525, 114, 12), ("lavender", "Lavender", 690, 114, 12),
    ],
}
SINGLE_CHOICE = ("gender", "pressure")

# Handwriting boxes (outer rounded rectangle x0, y0, x1, y1).
TEXT_BOXES = {"name": (105, 75, 349, 96), "nationality": (105, 126, 349, 146), "hotelName": (105, 156, 349, 177)}
# Form header: handwritten DATE and TIME boxes, the paper next to them where a date or time is often written instead
# (right of the printed label, right of the box; seen on real SUKHUMVIT 33 scans), and the model crop of the header =
# [DATE label + box + that paper] beside [printed "No." form number + TIME label + box + that paper].
HEADER_TEXT_BOXES = {"date": (253, 50, 349, 64), "time": (686, 52, 780, 65)}
HEADER_BESIDE_ZONES = {"date": ((326, 26, 405, 49), (349, 49, 405, 76)), "time": ((755, 31, 797, 50), (780, 50, 797, 70))}
HEADER_CROP_PARTS = ((248, 26, 405, 76), (676, 8, 797, 72))
# Writing line after the referral "Others 其他" label (customers write the reason there, e.g. "friend").
REFERRAL_OTHERS_LINE = (333, 280, 400, 300)

# Model crops. STAFF ONLY keeps the exact v2.2 crop (410,485,710,570); on a 569px page its last row is black padding.
STAFF_CROP = (410, 485, 710, 570)
# Customer crop = the Name row stacked on the Nationality + Hotel rows (the Gender checkbox row is left out).
CUSTOMER_CROP_ROWS = ((28, 71, 352, 100), (28, 121, 352, 181))

# Body map: (area, side, printed label box x0, y0, x1, y1, leader dot on the figure x, y).
BODY_LABELS = (
    ("Head", "front", 443, 186, 502, 193, 548, 190), ("Shoulder", "front", 435, 215, 502, 222, 536, 221),
    ("Arm", "front", 450, 242, 502, 249, 531, 247), ("Hand", "front", 451, 268, 502, 275, 531, 274),
    ("Thigh", "front", 442, 289, 501, 297, 546, 294), ("Calf", "front", 452, 315, 505, 321, 546, 320),
    ("Plantar", "front", 434, 330, 502, 336, 546, 336),
    ("Head", "back", 692, 189, 752, 195, 646, 194), ("Neck", "back", 692, 211, 748, 218, 641, 215),
    ("Back", "back", 692, 244, 747, 253, 641, 249), ("Waist", "back", 693, 258, 746, 265, 649, 263),
    ("Thigh", "back", 693, 291, 753, 299, 647, 297), ("Calf", "back", 692, 311, 743, 317, 647, 317),
    ("Plantar", "back", 687, 330, 760, 336, 647, 335),
)
BODY_REGION = (425, 178, 790, 346)
BODY_FIGURES = {"front": (525, 178, 598, 346), "back": (599, 178, 672, 346)}


def body_area_value(area, side):
    return f"{area} ({side})"


def describe_layout(width, height):
    """The response ``layout`` block (spec §1) for an image of the given size."""
    sx, sy = width / REF_W, height / REF_H
    aspect = (width / height) / (REF_W / REF_H) if height else 0.0
    match = abs(aspect - 1.0) <= ASPECT_TOLERANCE
    warnings = []
    if not match:
        warnings.append(f"aspect ratio {width / height:.3f} differs from template {REF_W / REF_H:.3f}; field positions may be misaligned")
    if width < REF_W * 0.6 or height < REF_H * 0.6:
        warnings.append(f"low resolution {width}x{height} (template {REF_W}x{REF_H}); marks may be missed")
    return {"template": TEMPLATE, "imageWidth": width, "imageHeight": height, "scaleX": round(sx, 4), "scaleY": round(sy, 4),
            "aspectMatch": match, "warnings": warnings}
