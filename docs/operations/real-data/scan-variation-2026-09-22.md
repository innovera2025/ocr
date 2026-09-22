Every one of the 95 pages is the same printed form, but the current v3 deterministic path misreads it on real scans. Registration only corrects shift. These scans are about 0.7% smaller than the calibration sample after resizing, and many are slightly rotated. So the printed box borders fall inside the "interior" windows and get counted as ticks. When I fit scale and rotation as well, all 95 pages register cleanly. The code was run with the model stubbed out and no customer text was read; the repo was not touched.

**Dataset.** All 95 pages are landscape, 1400×988–1000, from the Sukhumvit 33 print (the calibration sample is Ploenchit). None were rotated 90/180/270 and no other form turned up. Every page has blue ballpoint ink (black is at most 0.6% of ink pixels) and clean white paper. 17 pages have a pink PAID stamp. Your point about multiple pages holds: `api._decode` only processes page 1 of a PDF and warns about the rest.

## 1. Summary stats
Coordinates are in 805×569 reference px, and each page has 39 checkboxes.

**Current registration (translation only, ±5 px, 10 boxes):**
- **Offsets:** dx from −3 to +3, dy from −4 to +1. No page hit the edge of the search window.
- **Contrast:** 13.1–25.2, median 18.9. The calibration sample scores 48.2.
- **"Grid not found" warnings:** 11 pages (p034, p067, p068, p069, p070, p073, p075, p077, p083, p091, p095). All 11 are the correct form and register fine with the fitted method.
- **Clean pages:** 0 of 95. At the offset it chooses, every page has 8–31 boxes (median 17) that are ≥1.5 px off, and the worst box is 2.7–7.6 px off.

**Fitted registration (scale × shift search, rotation sweep, per-box ±2 px, 6-parameter fit):**
- **Result:** 95 of 95 pages register. Residual RMS is 0.39–0.73 px (max 2.1 px), and 38–39 boxes are inliers on every page.
- **Scale:** X 0.991–0.996 and Y 0.991–0.995 on every page. This comes from the scan margins: these pages have wider borders than the calibration sample, so the form shrinks when resized.
- **Rotation (skew):** −0.39° to +0.08°, median −0.145°. The rotation sweep agrees (−0.4° to +0.1°). 42 pages exceed 0.16° (1 px at the farthest box), 20 exceed 0.3°, and none exceed 0.5°.
- **Batch drift:** skew grows along the file order, averaging −0.03° for p021–040 and −0.31° for p061–080, with dy drifting to −3.6. It looks like a scanner feed drifting.
- **Template coordinates are fine:** after the fit, every box's average error is ≤0.55 px. Only the global scale, shift and rotation differ.

**Deskew:** no page needs an image rotation. Every page needs a scale and rotation correction, and the fit handles it.

**Timing (current path, model stubbed):**

| Step | Median | p95 | Max |
|---|---|---|---|
| Total | 81 ms | 100 ms | 110 ms |
| Decode | 9.5 ms | | |
| Preprocess | 56 ms | | |
| Checkbox + body map | 11 ms | | |

A lean version of the fitted registration adds about 28 ms (p95 38 ms) using numpy. It lands within 1 px of the full-sweep version (138 ms) on every page.

## 2. Outliers
- **p019, p031, p032, p036, p070, p095:** printed label text about 17 px to the right forms a rival peak. If the search models shift only, that peak wins; my first run locked onto it. The coarse search has to include scale.
- **Most-rotated batch (p061–p091):** the worst current misalignment (6.5–7.6 px), and 8 of the 11 false "not found" warnings.
- **p019, p031, p036 and others (10 pages):** the current code flags them "implausible" (9–10 boxes checked in the health or referral group). None are flagged after the fix.
- **Remaining false ticks after the fix:** p028 male, p038 rose, p093 standard (scores 0.11–0.125, border pixels after rounding to whole pixels).
- **Ticks drawn beside the box on the label (missed):** gender on p044, p052, p073; pressure on p019.
- **Genuine multiple marks:** pressure on p015, p023, p037, p041. p039 has the pressure labels circled instead of ticked.
- **PAID stamp over the customer text boxes:** p047 and p049. The stamp will appear in the model crop.
- **Lowest per-box contrast (29.8–35):** boxes covered by pen strokes, e.g. p025, p014, p005. They are still found.

## 3. Detector behaviour: real scans vs the one calibrated sample
**Why it fails:** printed box borders on these scans have luminance 179–187 (the calibration sample is 174). The "darker than paper" cutoff is 185, so misaligned border pixels count as ink. One border row inside an 8×8 interior gives a score of 0.125, above the 0.10 "checked" threshold.

**Current code, as-is:**
- **Gender:** 56 of 95 pages have more than one box checked; only 26 have exactly one.
- **Pressure:** 79 of 95 have more than one checked; only 4 have exactly one.
- **Health:** 63 of 95 pages report at least one condition (306 boxes).
- **Unflagged false claims:** 548 health/referral/oil entries go out with needsReview=false. Meanwhile needsReview is true on all 95 pages, so it tells you nothing.
- **Text boxes:** 53 of 285 blank name/nationality/hotel boxes read "present" (43–203 px of border). All 53 were checked visually and are empty.

**With fitted registration (checkbox logic unchanged):**
- 848 boxes the current code calls checked become unchecked. I viewed a sample sheet (252 boxes): they are empty boxes or strokes passing nearby.
- Gender has exactly one tick on 63 pages. Pressure has exactly one on 74. Health drops to 19 boxes on 18 pages.
- Visual check of every gender and pressure row: about 90 of 95 correct in each. The errors are the 3 false ticks and 4 beside-the-box misses listed above.

**Other patterns:**
- **Long-tailed ticks:** large ticks are labelled "stroke-through", so they need review. That covers 11 of 12 in pressure and 5 of 6 in gender (all scoring ≥0.15).
- **Lines through the oil row:** 38 pages have a wavy line through at least one oil box (19 through three or more), as on the calibration sample. This causes 106 of the 150 ambiguous boxes.
- **Health section:** 23 pages have a stroke through one health box.
- **PAID stamps:** they sit between the referral block and the body map. They never touch a checkbox, and 0 stamp pixels count as ink, because the orange filter also removes pink.
- **Faint marks:** none; paper luminance is 254–255 on every page.

**Body map (the weakest part):**
- 379 marks on 84 pages. Only 49% are on a label, and 72% need review.
- About half the marks are circles or crosses drawn on the figure itself, which get mapped to the nearest dot.
- Ticks beside labels come out as a cross or a circle.
- Some crosses on labels are read as circles (e.g. p095, head front).
- Single ellipses cover two labels (p002, p043).

## 4. Recommendations
1. **Registration:**
   - Coarse search over all 39 boxes: scale 0.98–1.01 in 0.0025 steps × shift ±24 px. Widen both for phone photos.
   - Then a local search of ±3 px per box, a least-squares fit that drops boxes more than 1.5 px off, and per-box positions taken from the fit.
   - Put the blank checkbox zones at those per-box positions, and place the text boxes and body map from the fit.
2. **Deskew:**
   - Only rotate the image when the fitted rotation is over 1°.
   - For larger skew, sweep ±3° in 0.25° steps and refine. The peak is sharp: contrast drops about 35% at ±0.5° and about 70% at ±1°.
   - Check 90/180/270 only when the 0° score fails. On these pages, rotated or mirrored versions score ≤9.6, except one mirrored page at 16.6.
3. **Box thresholds:**
   - Inside checkboxes, count blue pen ink at a 2 px inset, and "darker than paper" pixels only at a 3 px inset.
   - With correct registration, 3,229 of 3,263 blank boxes score exactly 0 (max 0.037). Blue-only scores are ≥0.094 on real ticks, ≤0.025 on blank boxes, and 0 on all 3 false ticks. The fixed 0.10 threshold is safe once border pixels are gone.
   - Call it stroke-through only when the stroke extends past both opposite sides of the box.
   - Widen the "mark beside box" check to cover the label to the right.
   - Treat a single stroke crossing three or more boxes in a row as "row struck out".
4. **Known form vs other format:**
   - Score S = mean ring contrast of the 39 boxes at their fitted positions. Also track the share of boxes found (contrast ≥20 within ±1 px).
   - Rule: known form if S ≥ 28, at least 75% of boxes found, RMS residual ≤1.0 px, scale 0.95–1.05 and |rotation| ≤3°. Process 20 ≤ S < 28 as the form but flag it for review. Treat S < 20 as another format.
   - Real pages: S = 42.2–50.0 (mean 45.3, SD 1.5); the calibration sample is 47.8. 100% of boxes found on every page.
   - Negatives (602 in total: each page rotated 90/180/270, mirrored and half-swapped, plus 30 synthetic forms with random checkboxes, a blank page and noise): S ≤ 16.6 (mean 6.9, SD 1.3), at most 44% of boxes found.
   - 28 is 11.7 SD below the real pages and 15.9 SD above the negatives. The current contrast threshold of 15 cannot separate them: it rejects 11 real pages, and one synthetic negative scores 17.8.
   - Score every PDF page and only run form extraction on pages that pass.

**Not verified here:**
- The body-map accuracy is a visual impression, not a labelled count.
- Whether numpy is importable in the production image. I assumed it comes with the paddleocr base image.

Files are in `<operator scratch dir, not in git>/`:
- `per_page.json` (all measurements per page, plus the calibration sample and the synthetic negatives)
- `per_page_raw.json`
- `box_features.json`
- scripts: `measure.py`, `summarize.py`, `feat.py`, `lean.py`, `montage.py`, `rows.py`, `sheet.py`
- `m_*.png` and `sheet_*.png` are the images I checked by eye. They contain crops of real customer pages, so treat them as sensitive.