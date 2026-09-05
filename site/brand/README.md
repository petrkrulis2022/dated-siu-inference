# Brand source assets

Raw source for the Touchstone Assay mark — not served by the site directly. The built,
served assets (`site/static/logo.png`, `site/static/favicon.png`) are both derived from
`touchstone-assay-mark-render.jpeg`: chroma-keyed to transparent (the render's flat
`#F1EEE7` background), cropped, and resized.

- `touchstone-assay-mark.glb` / `.obj` / `.mtl` — the 3D model.
- `touchstone-assay-mark-render.jpeg` — a rendered angle of the model, the source for the
  site's logo and favicon.

Regenerating `logo.png`/`favicon.png` from a new render: chroma-key against the render's own
flat background color, crop to the content bounding box, and export as PNG (transparency
requires PNG, not JPEG).
