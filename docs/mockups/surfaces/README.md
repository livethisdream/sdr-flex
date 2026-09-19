# Surfaces prototype — how many things are on screen?

Serve the repository root and open `docs/mockups/surfaces/`. It borrows
`../../../web/style.css`, so it has to be served from somewhere that can see `web/`.

The [layout study](../layout/) got chrome from 174 px down to about 90 px and then
stopped paying. What is left to win is not height — it is the number of separate
surfaces on screen and the number of different menus behind them.

Three proposals, made clickable rather than drawn, because a popunder and a hover are
behaviors:

1. **One bar.** The crumb you are standing on opens the rest of the map, so the block
   tab row folds into the breadcrumb instead of sitting beside it.
2. **No parameter strip.** Node and view values are summoned — hover a crumb, or `i`
   to pin the card open. The 2 px auto/manual edge and the evidence
   ([ADR-0017](../../adr/0017-auto-manual-parameters.md)) move onto the card.
3. **One menu, three gestures.** A selection drag asks about the signal, a bare click
   asks about the picture, a right-click asks about the node. Same surface, different
   first tier — the discriminator [ADR-0039](../../adr/0039-the-menu-answers-the-gesture.md)
   already has for free.

The page counts clicks and pointer travel live, and states what each proposal breaks
against rules that are already written down. Two of the three costs have answers in the
prototype; the third does not yet.

Note that ADR-0018 already specifies a breadcrumb whose segments are "a menu of its
siblings" — the popunder is not new. What is new is folding the *blocks* in too.

This is an exploration, not a decision. Nothing here has an ADR behind it.
