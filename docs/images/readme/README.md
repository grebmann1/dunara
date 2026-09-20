# Dunara README artwork

Two original atmospheric illustrations extend Dunara's existing ivory, sand,
charcoal and rust art direction into a post-apocalyptic desert. They portray
exploration and rebuilding; they are not screenshots or photographs.

| Asset | Scene | Size |
| --- | --- | --- |
| [dunara-frontier.webp](dunara-frontier.webp) | An ivory-suited explorer overlooks dunes, weathered towers and a restored settlement at sunrise. | 1600 × 900 |
| [dunara-outpost.webp](dunara-outpost.webp) | An explorer repairs a mechanism in a warm workshop beneath an enormous ruined arch. | 1600 × 900 |

## Creation and reuse

Generated on September 20, 2026 through the OpenAI image API using the bundled
imagegen CLI fallback, with user authorization. Both requests used `gpt-image-2`,
high quality, 2048 × 1152 output and WebP compression 94. No reference files,
private project content or credentials were included in the prompts.

The exact prompt set is preserved in [frontier.txt](prompts/frontier.txt) and
[outpost.txt](prompts/outpost.txt). Both outputs were visually inspected, resized
proportionally to 1600 × 900 and encoded as WebP at quality 86 for the README.
No crops, composited interfaces, text overlays or color edits were applied.
Full-resolution authoring outputs are retained locally under
`output/imagegen/dunara-readme/`; the README consumes only the optimized assets
in this directory and makes no image-generation requests.

These contributed illustrations are provided under the repository's Apache-2.0
license to the extent applicable, without asserting exclusive copyright in
AI-generated pixels. The geometric Dunara mark is the separate shared brand
asset in `packages/catalog/assets/brand-mark.svg`.

## Product imagery

The README's Studio image is the existing
[sidebar review capture](../sidebar-ux/desktop.png), acquired from a disposable
project with Preview stopped. Its pixels are unchanged. It is an actual product
capture, distinct from the two generated atmospheric illustrations above.
