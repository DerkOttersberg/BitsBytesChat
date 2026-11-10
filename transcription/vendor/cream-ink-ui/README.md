# Cream and Ink UI

A small, reusable interface skin published by **derk** on [Abzweig](https://git.derkdev.nl).
Cream panels, ink headers, subtle halftone textures, square buttons, and mint
actions, using locally bundled Roboto Condensed fonts.

![Cream and Ink component reference](docs/preview.png)

## What's included

- `web/theme.css` — scoped styles, surfaces, controls, tabs, and dialogs.
- `web/skin.js` — explicit decoration, hover/press states, and optional tab handling.
- `assets/` — the original two fonts and three small texture masks.
- `tokens.json` — palette, dimensions, surface recipes, and motion values.
- `assets.json` — asset origins and SHA-256 checksums.
- `examples/index.html` — a working, responsive component example.
- `docs/` — integration notes, visual rules, and the component reference image.
- `licenses/` — the original font license and notices.

No build step, framework, package manager, or external font service is needed.

## Try the example

```sh
git clone https://git.derkdev.nl/derk/cream-ink-ui.git
cd cream-ink-ui
python -m http.server 8000 --bind 127.0.0.1
```

Open `http://127.0.0.1:8000/examples/` in your browser. You can also open
`examples/index.html` directly for the basic static example.

## Add it to your own app

Copy `web/`, `assets/`, and `licenses/` together into your project, preserving
their relative paths. Load the stylesheet, give your app the `ci` class, and
mount the helper on your app's container:

```html
<link rel="stylesheet" href="cream-ink-ui/web/theme.css">

<main id="app" class="ci">
  <section class="ci-panel ci-stack" data-ci-surface="paper">
    <h2>Your workspace</h2>
    <p>Your existing application content.</p>
    <button type="button" class="ci-button" data-ci-surface="primary">Save</button>
  </section>
</main>

<script src="cream-ink-ui/web/skin.js"></script>
<script> CreamInk.mount(document.getElementById('app')); </script>
```

The helper supplies the decorative layers and interaction styling. Your app
still owns its buttons, navigation, validation, and dialog behavior. See
[integration and API notes](docs/integration.md) and the [style guide](docs/style-guide.md).

## Check the assets

```sh
python tools/verify-assets.py
node --check web/skin.js
```

The asset check verifies all five original font and texture files against the
included manifest. It requires only Python's standard library.

## Abzweig integration

This is the standalone skin. The Forgejo-specific templates, dashboard styling,
and installation scripts used by Abzweig are maintained in
[git-dashboard](https://git.derkdev.nl/derk/git-dashboard).

## Credits and notices

The visual source is derk's supplied Cream and Ink UI export from October 2026.
Roboto Condensed is by Google / Christian Robertson and is distributed under
Apache License 2.0. Keep the bundled [font notice](licenses/FONT-NOTICE.txt),
[font license](licenses/Roboto-Apache-2.0.txt), and [asset provenance](assets.json).
See [third-party notices](THIRD_PARTY_NOTICES.md) for the scope of those notices.
