# Quality Control

Quality control is a **composite of analyzers**. Each measures only what it
genuinely can; the composite merges them and is explicit about the difference
between an observation and an estimate.

What is actually measured scales with the environment:

| Environment | What becomes real |
|---|---|
| Nothing installed | File existence only. Everything else estimated. |
| **+ FFmpeg** (bundled — works out of the box) | Technical integrity, temporal stability, motion plausibility, reference similarity, subject/product drift |
| **+ `ANTHROPIC_API_KEY`** | Plus perceptual review: anatomy, branding legibility, material realism, cross-frame identity |

The UI's **Quality control** panel shows which analyzers are live and what each
one needs.

---

## The analyzers

### `technical` — technical integrity
**Measures.** Verifies the file exists, decodes, and matches the request in
duration, resolution, frame rate and bitrate. Runs first: these failures make
everything downstream meaningless.

### `temporal-signal` — temporal stability, motion plausibility
**Measures.** Reads the per-frame difference signal with
`tblend=all_mode=difference,signalstats` — literally "how much did this frame
change from the last one", on a 0..255 scale. Derives three failures:

| Failure | Signal | Why it matters |
|---|---|---|
| **Frozen output** | mean delta < 0.35 | The clip is a still image. The file is valid, the duration is right, and nothing moves — a totally silent failure nothing else catches. |
| **Flicker** | mean delta > 45 (critical), > 22 (warning) | Strobing rather than moving. |
| **Discontinuities** | frames beyond mean + 3σ | Content jumps rather than moves. Only `critical` when the jumps are also large (> 25/255) — a statistical outlier of 9/255 is invisible to a viewer. |

Calibrated against synthetic fixtures and asserted in
`tests/quality-analyzers.test.ts`: frozen ≈ 0.2, gentle motion ≈ 0.6, healthy
motion ≈ 5, hard alternating flicker ≈ 96.

**Intent-aware.** A deliberately locked-off shot has the same pixels as a frozen
generation. The analyzer reads the requested `cameraMoveIntensity` and
`subjectMotion` from the spec and does not flag a shot that was *asked* to hold
still.

### `signature-similarity` — reference similarity, subject/product drift
**Measures.** Reduces frames and reference images to a 16×16 RGB fingerprint and
takes the normalised cross-correlation. Two independent things:

1. **Reference similarity** — do the frames resemble the supplied identity
   reference at all? Catches "the model generated a completely different
   product".
2. **Subject drift** — do the frames diverge from *each other* more than the
   requested camera movement accounts for? Catches the characteristic failure of
   longer generations: it started as the right cup and slowly became something
   else. The expectation is scaled by `cameraMoveIntensity`, so a pull-out is not
   penalised for revealing new scenery.

**Honest limit.** This is a coarse colour/layout fingerprint. It sees gross
shape, palette and composition. It **cannot** read a logo, count fingers, or
judge whether a texture looks edible. It reports at `medium` confidence and says
so in `notCheckedNotes`.

### `vision-judge` — anatomy, branding, materials, identity
**Measures.** Samples four frames and shows them to a vision model together with
the constraints *this specific shot* was generated under — what should be in
frame, which realism domains were strict, what the reference was meant to
preserve, how much movement was requested. Returns per-dimension scores and
concrete visible defects.

This is the only analyzer that sees semantic defects. The signature analyzer
knows the cup is still cup-shaped and cup-coloured; only this one can tell you
the hand has six fingers or the logo now reads "COFEE".

Requires `ANTHROPIC_API_KEY`. Without one it sits out cleanly. It also skips mock
output — judging a placeholder slate wastes tokens and tells you nothing.

### `risk-prior` — the gap filler
**Estimates.** The only analyzer that does not measure. Fills dimensions no real
analyzer could assess, so the repair loop has something to rank by. Every score
is `measured: false`, contributes at 35% weight, and is always superseded by a
real measurement.

---

## Merge rules

These are what make the composite honest:

1. **A measured score always beats an estimate**, regardless of analyzer order.
2. **Between two measurements, the lower score wins.** A defect found by any
   technique is still a defect — averaging it away with a technique that could
   not see it would hide real problems.
3. **Confidence is the best confidence among analyzers whose measurements
   survived the merge** — an analyzer that was overruled cannot raise it.
4. **`notCheckedNotes` lists only what genuinely went unmeasured**, so the report
   never over- or under-claims.

An analyzer that throws is skipped and logged, never fatal.

---

## Gates and repair

`spec.quality` sets the thresholds:

| Target | Default |
|---|---|
| `minOverall` | 0.7 (0.8 at maximum realism, 0.6 at standard) |
| `minTemporalConsistency` | 0.65 |
| `minSubjectConsistency` | 0.75 with an identity reference, 0.6 without |
| `maxRepairAttempts` | 2 |

A shot passes when it clears all three and has no `critical` issue.

The repair planner acts on the **specific** failure, not a generic retry:

| Detected | Repair |
|---|---|
| `frozen_output` | **Raise** camera movement and require continuous motion — the one case where reducing movement is exactly wrong |
| `severe_flicker` | Cut movement to 35%, halve speed, shorten the shot by 30% |
| `reference_mismatch` | Strengthen reference-adherence language |
| Temporal instability | Halve movement, shorten the shot |
| Subject/product drift | Strengthen identity-lock language |
| Anatomy | Reduce subject motion to micro, strengthen anatomy negatives |
| Infrastructure failure | New seed, nothing else changed |

Mock output is exempt from gating: there is nothing meaningful to score, so it
passes with a `warning` explaining that it is a placeholder.

---

## Adding an analyzer

Implement `QualityAnalyzer` and add it to the list in
`src/lib/quality/composite-evaluator.ts`:

```ts
export class MyAnalyzer implements QualityAnalyzer {
  readonly id = "my-analyzer";
  readonly label = "My technique";
  readonly capabilities = {
    dimensions: ["humanAnatomy"],
    requiresGpu: false,
    requiresModel: null,
    description: "What it actually measures — and what it does not.",
  };

  async isAvailable(input: EvaluationInput) { return true; }

  async analyze(input: EvaluationInput): Promise<AnalyzerContribution> {
    return {
      analyzerId: this.id,
      scores: [{ dimension: "humanAnatomy", score: 0.8, measured: true, method: "…" }],
      issues: [],
      confidence: "high",
      notCheckedNotes: [],
    };
  }
}
```

Nothing else changes — the merge rules pick it up, and the UI panel lists it.

**The one rule:** `measured: true` means you looked at the pixels. If you did
not, say so.

### Worth adding next

| Analyzer | Approach | Catches |
|---|---|---|
| **Embedding similarity** | CLIP/DINOv2 instead of the 16×16 fingerprint | Fine-grained product identity the signature misses |
| **Optical flow** | Dense flow field coherence | Warping and morphing that frame differencing reads as ordinary motion |
| **Face identity** | Face embedding distance across frames | The specific "the face changed" failure |
