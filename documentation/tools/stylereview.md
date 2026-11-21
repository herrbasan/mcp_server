# Style Review

`stylereview.review` reviews a live URL or local `.html` / `.svg` file through
headless Chromium. It combines deterministic Tier-0 facts with one LLM critique;
the model does not invent page elements or NUI APIs.

## Invocation

```json
{
  "method": "stylereview.review",
  "payload": {
    "target": "http://127.0.0.1:3100/nconvert",
    "probeInteractions": true
  }
}
```

- `target` (required): `http(s)://` URL or absolute `.html` / `.svg` path.
- `viewports`: optional `[{ name, width, height }]`. HTML defaults to desktop
  1440×900 and mobile 390×844; SVG defaults to 1280×900.
- `probeInteractions`: opt in to bounded multi-step usage-flow probing.
- `tier0Only`: return structured measurements without an LLM call.
- `model`: override `agents.stylereview.model` (default `deepseek-flash-chat`).

## UX usage flows

Every HTML review includes a semantic inventory of visible headings, actions,
forms and their controls, dialogs, selected/expanded states, and live feedback
regions. This lets the critique discuss actual user tasks rather than only CSS.

With `probeInteractions: true`, the reviewer:

- Starts up to six flows from safe visible buttons, tabs, disclosures, and
  same-origin links.
- Follows up to three steps per flow, preferring controls newly revealed by the
  previous step or inside the active dialog/panel.
- Restarts each root flow from the initial URL and records chronological state:
  headings, actions, forms, open dialogs, active tabs, feedback, and navigation.
- Reports actions with no visible text, control-state, or URL change in
  `silentClicks`; the LLM decides whether feedback was actually expected.
- Excludes submit, destructive, and other data-mutating labels. It is a bounded
  reviewer, not an unrestricted crawler, and does not submit forms.

## NUI documentation and conformance

NUI mode activates when the page loads `nui-theme.css` or contains `nui-*` tags.
Only then does the LLM receive the complete local nui_wc2 reference:

- `documentation/components.json`;
- `LLM-CHEATSHEET.md`;
- every `documentation/components/*.md` and `documentation/addons/*.md` file.

The catalog also includes registered core/addon tags found in the NUI source, so
components omitted from the generated registry remain visible to the reviewer.
`agents.stylereview.nuiRoot` overrides the default `src/nui_wc2` checkout.

Tier 0 scans the full DOM, including dormant dialogs, and separates:

- `nui.issues`: definite contract violations — bare native controls, invalid
  documented native children, checkables without direct labels, native form
  attributes placed on wrappers, invalid dialog page mode, malformed tabs/table
  structure, misplaced `nui-main`, and bespoke component styling.
- `custom-nui-styling`: inline styles on NUI wrappers or their documented native
  children, plus author stylesheet rules targeting them by tag, class, ID, or
  other selector. `nui.customStyles` records the source, element, selector,
  properties, and values. NUI library stylesheets and token-only declarations
  are excluded; use documented variants/attributes/tokens or style an
  application-owned wrapper instead. Unreadable cross-origin stylesheets and
  unsupported selectors appear in `nui.styleScanWarnings` so the audit cannot
  silently claim complete CSS coverage.
- `nui.opportunities`: native dialogs, disclosures, code blocks, tablists,
  tables, progress, and media for which a documented NUI component exists.
  These are candidates, not automatic defects; the LLM must justify a
  recommendation from the actual content/workflow and the injected docs.

`nui.tagsUsed`, `nui.unknownTags`, and `nui.catalogCount` provide inventory.
The full NUI documentation is sent to the model but not duplicated in the raw
JSON report.

## Other checks and output

Tier 0 measures overflow, clipping, overlaps, row alignment, typography,
contrast, accessible labels, cursor affordance, and SVG text collision/clipping.
Console and page errors are included. The normal result is a concise grouped
Markdown review followed by raw JSON metrics; `tier0Only` returns the JSON only.

Validation: `npm run test:stylereview` covers the live `/nconvert` page, complete
NUI documentation injection, SVG checks, dormant-control wrappers, NUI contract
misuse/opportunities, bespoke component styling, and a multi-step tab → dialog flow.
