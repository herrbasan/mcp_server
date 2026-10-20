# Chart hybrid — experiments log

Working document. What was tried, measured, and concluded. Curated reference lives
in `documentation/tools/chart.md`; this is the evidence behind it.

All runs 2026-10-20 unless noted. Local GPU (COOLKID), `$0/image`, images via the
LLM Gateway `/v1/images/generations` with an init image.

---

## E1 — Restyle model A/B: krea2 vs moss

**Question.** Is `coolkid-moss-image` a better restyler than `coolkid-krea2` for
the textless-base pipeline?

**Method.** Same spec, same prompt, same base (1920 px, stroke 2.5 and 4), denoise
0.12 / 0.25 / 0.4 / 0.45 / 0.65, on the simple flow and the custom composition.

| Model | Boxes | Icons | Colour | Thin connectors | Ink character |
|---|---|---|---|---|---|
| krea2 | ok | redrawn as blobs at 0.45 | lost at 0.45 | mostly ok at 0.3 | yes at 0.45 |
| moss | ok at every denoise | **crisp, every run** | **survives, every run** | **fragment at every denoise** | none below ~0.75 |

**Conclusion.** Moss is better at glyphs and colour, worse at the thing that
carries the argument. Rejected as the shipped restyler; krea2 stays at 0.3 / 12.
Moss stays reachable via `chart.hybrid({ model: "coolkid-moss-image" })`.

**Open lever.** Moss's notes advertise "JSON layout prompts with bboxes"; a
bbox-per-shape prompt handling connectors better is untested.

---

## E2 — Moss as a full renderer (text included)

**Question.** Moss is good at text. Can it draw the whole diagram — text and
shapes — from a structured prompt at high denoise?

**Method.** Full render supplied as the init image. Prompt carries every string
(title, caption, per-box label + detail, per-edge label) and bboxes, with the
body `<g transform="translate(…)>` added to the rect coordinates.

| Denoise | Background | Text | Structure |
|---|---|---|---|
| 0.55 / 0.60 | white, correct | **exact**, caption included | exact |
| 0.70 | white | "normalises" → "normalizes" | wires recoloured orange |
| 0.75 | white | exact | exact, but **typeset lettering** |
| 0.85 | white | "write" dropped, caption "bacc", invented `gw` cloud | groups lost, topology changed — **but handwritten** |

**Conclusion.** Two coupled properties: hand-lettering appears only around 0.85,
which is also where fidelity fails; below 0.75 the text is exact but typeset.
Handwriting is not a style switch in this model — it is the mode where fidelity
drops. A text check that compares rendered words to the spec is required before
this can ship; without it, a dropped label or a misspelled caption goes unnoticed.

---

## E3 — Why the background came out dark

**Observation.** Early moss runs returned a slate-blue board.

**Cause.** The reference PNG was **transparent** — the spec had no `background`
and nCharts leaves the canvas empty — and moss reads transparency as a dark board.
Not the prompt.

**Fix.** Render the reference with `background: true` (or run it through
`geometryBase`). With an opaque reference every subsequent run was white.

**Side finding.** At denoise ≥ 0.85 the model ignores a background colour stated in
the prompt (`#FBF9F5` requested, grey returned). Background has to come from the
image, not the wording.

---

## E4 — Prompt wording: "whiteboard" pulls the whole aesthetic

Same text, same denoise, one phrase changed:

| Wording | Result |
|---|---|
| "hand-drawn whiteboard sketch" | slate board, white marker, layout rearranged, "llama.cpp" → "iänna.cp" |
| "fine pen on plain warm white paper, … no board, no slate" | grey background, invented "Dwords use to a asfrche burcade tion", stray car icon, doubled box, accent lost |

**Conclusion.** "Whiteboard" overrides an explicit paper instruction in the same
prompt. At high denoise, colour words are advisory; the init image is authoritative.

---

## E5 — Perception channel (not a model experiment, but measured here)

Can a model see an image a tool returns?

| Channel | Arrives |
|---|---|
| User pastes an image | **yes** — verified blind on a file-tree screenshot and on a generated chart |
| MCP image block, gateway provider | no |
| MCP image block, deepseek provider | no |
| `view` on a file path | no |
| Browser screenshot | no |

**Contamination trap.** Twice a "I can see it" reading was wrong: the image had
already been described by `vision.analyze` earlier in the same session, so the
description was recall, not sight. A blind test needs an image whose content was
never described — the one used here was `charts/…e2e-tree-latency.svg`, rasterized
and ingested; none of its labels could be read. Ground truth afterwards:
"Where the time goes / Latency / Prefill / Decode / Tokenising / Attention /
Weights / Context".

Upstream, open: `microsoft/vscode#339600`, `microsoft/vscode#326276`.

---

## Reproduce

```bash
# textless base with an opaque page colour (required: transparency becomes a dark board)
chart.render({ spec, text: false, strength: 4 })

# restyle-model A/B
chart.hybrid({ spec, model: 'coolkid-moss-image', denoise: 0.3, check: true })
chart.hybrid({ spec, denoise: 0.3, check: true })   # krea2 via the configured chain

# full-render mode (text supplied in the prompt) needs the base rasterized through
# nMedia first; the bboxes must include the body translate
```
