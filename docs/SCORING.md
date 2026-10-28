# Visual scoring: definition and validation

## Definition

For a reference image R (Figma PNG, frame width, 1x) and a rendered image O (Chromium, same CSS width, device scale 1, scrollbar compensated):

score = (0.3·SSIM(k1=0.05) + 0.25·(1 − pixelmatch mismatch ratio) + 0.3·edge F1 + 0.15·colour-histogram intersection) × height ratio

- **SSIM** (ssim.js, "fast", at 0.5 scale): structure/contrast/luminance agreement.
- **Pixel**: share of pixels pixelmatch (threshold 0.1, anti-aliasing ignored) considers equal.
- **Edge F1**: Sobel edges (|∇| > 60) of both images matched within 2px — text, borders and shape outlines in place.
- **Colour**: 8×8×8 RGB histogram intersection — palette agreement independent of position.
- **Height ratio**: min(h)/max(h) — content that is missing or extra cannot score well.

It is computed for the full page and for every section crop (sections aligned by their rendered DOM position, so a shift in one section does not pollute the others). A section floor prevents a good average hiding one bad section.

## Validation (2026-10-22, 13 real section crops from the design)

Threshold under test: **0.85**. 45 weightings × SSIM k1 were evaluated on the same perturbations; 6 satisfied all three checks. Selected: k1 = 0.05, weights {"ssim":0.3,"pixel":0.25,"edge":0.3,"color":0.15} (margin 0.002 around the threshold).

Before calibration (k1 0.05, weights {"ssim":0.45,"pixel":0.25,"edge":0.15,"color":0.15}): monotonic true, noise passes true, defects fail false.

| Perturbation | Expected | Crops | Pixels changed (mean) | Mean | Min | Max |
|---|---|---|---|---|---|---|
| identical | noise | 13 | 0% | 1 | 1 | 1 |
| shift 1px | noise | 13 | 6% | 0.9685 | 0.9411 | 0.9878 |
| blur r1 (antialiasing / font hinting) | noise | 13 | 5% | 0.9848 | 0.9704 | 0.9932 |
| tint +6 (colour profile) | noise | 13 | 0% | 0.9703 | 0.8967 | 0.9994 |
| shift 4px | borderline | 13 | 13% | 0.9007 | 0.8009 | 0.9496 |
| tint +40 (wrong colour) | defect | 13 | 100% | 0.7626 | 0.6737 | 0.848 |
| shift 16px | defect | 13 | 23% | 0.7202 | 0.638 | 0.7736 |
| missing content block (30% of crop, densest area) | defect | 9 (4 skipped: <5% changed) | 12% | 0.7606 | 0.7092 | 0.8042 |
| blur r4 (wrong image res) | borderline | 13 | 13% | 0.9303 | 0.8845 | 0.958 |
| blank page | defect | 13 | 84% | 0.2815 | 0.0062 | 0.6456 |

- Monotonic with severity: **yes**
- Rendering noise (≤1px shift, slight blur, small tint) passes the threshold on every crop: **yes**
- Real defects (wrong colour, 16px shift, missing 30% content block, blank) fail it on every crop (heavy blur is borderline here; low-resolution images are caught by structure.image-upscaled): **yes**

Metric considered **valid** for gating at 0.85.

## Limitations

- A substituted font lowers the score in every text-heavy area even when layout is correct; reports name the substitution so the cause is visible.
- The metric compares at the design frame widths only; other widths are covered by the responsive checks (overflow, overlap, clipping), not by pixel similarity, because no design exists for them.
- Dynamic content must be masked (config qa.masks) or it lowers scores.
- Large flat areas (solid backgrounds) inflate the pixel and colour terms; the section floor and edge term counteract that.
- A small missing element (< ~5% of a section) barely moves a whole-section score. That is caught by the structure (element/text/image presence) and geometry categories, not by this metric — which is why the gate requires all categories.
