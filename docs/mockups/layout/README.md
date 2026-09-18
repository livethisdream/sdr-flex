# Layout mockups — where the bars go

Open `index.html` in a browser, or serve the repository root and visit
`docs/mockups/layout/`. It needs `../../../web/style.css`, so it has to be served from
somewhere that can see `web/` — the repository root is the obvious one.

Five layouts for the same screen. They are built from the app's own stylesheet and the
mockup sheet only ever sets *layout*, so no screen here can look better than the app
could actually build; the diff between these and today is exactly the diff being
proposed.

Every number under a screen is measured off the rendered DOM at the selected viewport,
including which rows clip and which merely scroll. Nothing is typed in, which is the
same rule [`docs/08-ui-principles.md`](../../08-ui-principles.md) applies to the
product.

`?w=1024`, `?only=ends`, `?theme=light` deep-link a viewport, a single screen and a
theme.

This is an exploration, not a decision. Nothing here has an ADR behind it.
