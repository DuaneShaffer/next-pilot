# Interface rules

This is the project's differentiator, so it gets the most specific document. Every rule here is
written to be *checkable* — either by a test, or by looking at a screenshot and asking a yes/no
question. Vague principles don't survive contact with a deadline.

## Why this document exists

Shooter-roguelikes reliably ship the same interface failures:

- HUD drawn on top of the play area, so reading your health means not seeing the bullet.
- Bare numbers with no units. Is `1.15` a multiplier, a percent, or seconds?
- Item text written as flavour, leaving the mechanical effect a guess.
- Twenty upgrade icons in a row with no indication which ones interact.
- Four clicks and two loading screens between death and the next run.

Each of these is a solved problem. Solving them consistently is the goal.

---

## 1. The HUD never overlaps the playfield

The play area is 448×720 virtual units; the instrument panel is a dedicated 192-unit column to
its right. Nothing that conveys persistent state is drawn over the play area.

**Why:** in a bullet-heavy game, a translucent overlay competes with the exact pixels the player
must read to survive. Reserving space costs screen area once; overlaying costs attention
continuously.

**Permitted exceptions**, because they are transient and attached to the action rather than
being state readouts: floating damage numbers, pickup labels, boss-phase callouts, enemy damage
bars, the lock-on/threat indicators for off-screen enemies, and the hazard reaction-window alarm
(`drawHazardWarning` — it exists only during the one second a hazard gives the player, lives in
the outer margin plus a strip under the hull, and is gone the moment the hazard fires).

**Two things over the playfield are genuinely state, and are allowed anyway.** Recorded here
rather than left to be rediscovered as violations:

- the **low-integrity rim**, which is persistent by definition. It is the one readout whose whole
  job is to be seen without looking away, and putting it in the panel is putting it where rule 9
  says nobody is looking. It stays in the margin and never touches the space bullets are read in.
- the **blackout scrim**, which is a hazard's effect rather than a readout: it dims the field on
  purpose, and enemy fire and the player's hull are drawn *on top of it* at full contrast so the
  thing that kills you is never the thing that was hidden.

**Check:** no call in `src/render/panel.ts` or `src/ui/**` draws at `x < PLAYFIELD_W` while the
simulation is running — a full-screen overlay (pause, item choice, incident report) is permitted
because the sim is paused underneath it and there is nothing to occlude. Anything `src/render/**`
adds over the playfield must be on one of the two lists above.

**Gap, honestly:** the only test enforcing this sweeps `drawPanel` (`tests/render.test.ts`).
Nothing sweeps `src/render/scene.ts`, which is where every over-playfield draw actually lives, so
the lists above are maintained by review rather than by a failing test.

## 2. Every number carries a unit and a direction

`+15% fire rate`, not `FR 1.15`. `2.4 shots/s`, not `2.4`. `-8 hp/s`, not `8`.

Use `drawValue()` from `src/render/text.ts`, which renders the unit dimmer than the value so
scanning stays fast. Where a stat can go either way, the sign is always shown — `+0.3 s` and
`-0.3 s` must be distinguishable at a glance, and for a duration those are opposite outcomes.

**Check:** grep the panel and item rendering for a numeric value drawn without an adjacent unit.

## 3. Colour is information, never decoration

The palette in `src/render/palette.ts` assigns meaning:

| Token          | Means                                                    |
| -------------- | -------------------------------------------------------- |
| `self`         | You, your projectiles, focus and selection               |
| `danger`       | Can hurt you **this instant**. Nothing else. Ever.       |
| `dangerText`   | The same role as a glyph rather than a mark — see rule 7 |
| `hostile`      | Enemy hulls and structures                               |
| `hostileElite` | Elite / reinforced enemy accent                          |
| `caution`      | Resource running low, timer expiring, risky choice       |
| `good`         | Healing, gains, successful extraction                    |
| `relic`        | Rare tier                                                |

**Why:** if `danger` red is also used for a decorative border, the player's threat-detection
reflex gets trained on noise, and the one time it matters they don't look.

**The `danger` / `hostile` split is deliberate and narrower than "the enemy."** Enemy
*projectiles* are `danger` and are the most saturated, highest-contrast thing on screen. Enemy
*hulls* are `hostile` — cold steel, clearly readable, not screaming. If everything hostile were
danger-red, the projectile the player must actually dodge would stop standing out, which is the
precise failure this rule exists to prevent. A bullet-hell screen has one job: make the bullets
the loudest thing in the room.

**Draw order enforces the same priority** (see `docs/ARCHITECTURE.md`): enemy projectiles are
drawn *above* enemies, so incoming fire is never occluded by the thing that fired it, and the
player's hull is drawn last so it is never hidden.

**Also:** colour never carries information *alone* — roughly 1 in 12 men has some form of colour
vision deficiency. Danger reads as red *and* has a distinct silhouette; a depleted meter reads
as red *and* short.

### That claim was aspirational until it was measured

`tests/palette.test.ts` simulates protanopia, deuteranopia and tritanopia and requires ΔE00 ≥ 15
between every pair of roles that must be told apart. **Nine of eighteen pairs failed.** The worst
was not subtle:

- **`caution` and `hostileElite` were byte-identical** — `#F5B942` both. Two roles this very table
  distinguishes, written as the same six characters. No simulation was needed to see it; nobody
  had looked.
- **`self` / `hostile` at ΔE 12.8 for a deuteranope** — your own hull against enemy hulls, for ~5%
  of men, in every frame of every run.
- **`self` / `good` at 1.5 for a tritanope** — below the just-noticeable difference, on adjacent
  rows of the hangar.

Eight are fixed by recolouring. One is not fixable at all: **`danger` / `caution` differ almost
entirely along the L–M axis, which is precisely the axis protanopes and deuteranopes lack**, and
both read as yellow to a tritanope. A constrained search over the whole palette reached ΔE 12.8 at
best, and only by costing `caution` its separation from `good`.

That pair mattered in exactly one place — the integrity meter going critical, which used to be a
hue swap *in place*: same bar, same segments, same position. For a deuteranope, the most important
state change in the game was invisible. It now also cuts notches into its filled segments, which
survives greyscale, all three simulations, and a photograph of a screen.

So the rule stands, but the enforcement is the point: `REDUNDANT_CHANNEL` in that test file is a
named tier, not an exemption, and landing a pair in it is a claim that something other than hue
distinguishes them — with the place named, so it can be checked against a screenshot.

**Check:** `danger` appears in the codebase only for enemy fire, incoming damage, hazards that
take integrity, critical resource states, death, and the one irreversible action on the pause
card (`abandon`, which also carries a bar rather than colour alone).

**"Hazards that take integrity" is narrower than "hazards", and one function decides it.** A
hazard in its reaction window earns `danger` only if firing costs the player integrity —
`corrosion` and `debris` do, `interdiction` and `blackout` do not, read from what
`src/sim/world.ts` applies rather than from `HazardDef.damage`, which is dead data for those two
kinds. The panel row and the playfield alarm both call `hazardSeverity` in
`src/render/hazards.ts` for this. They did not always: the panel gave every warning the danger
role while the alarm derived it from the kind, so for one second at a time the two surfaces
contradicted each other about the same hazard. **Two derivations of one judgement is the defect,
not the wrong answer** — if a rule has two surfaces, one function decides and both call it.

## 4. Item text states the mechanism first

Format is fixed:

```
COIN-OPERATED CANNON                          [uncommon]
+18% fire rate for 3 s after collecting scrap.
"Requisition insists this is a feature."
```

Line 1 is the name and tier. Line 2 is the complete mechanical effect with real numbers, in one
sentence. Line 3 is flavour, visually subordinate, and always omittable.

**Why:** a player choosing between three items under time pressure needs the mechanism, not the
joke. Putting flavour first makes every choice a coin flip. Keep the humour — put it third.

### Who states the numbers depends on whether the screen computes them

The rule above is about what the *player* must be able to read, not about which string carries
it. Where a screen resolves the figures against the actual run and prints them in a table, **the
table states the numbers and the sentence states the intent**; the sentence does not restate
them. Where a screen has no such table, the sentence states the numbers, exactly as above.

**Why:** restating a computed figure in hand-written prose is one fact in two places with only
one of them derived. A balance change updates the table, the table is right, and the sentence
goes on selling the old thing. That is not hypothetical — it is finding R12, where three
certification cards promised numbers their hulls no longer had, and it happened again the day
resolved rows landed on the offer cards and Barrel Liner drew `Shot speed 620 → 740 u/s (+120)`
directly above "+120 projectile speed, from 620 to 740 units per second".

Two screens are on the table side of this, and both are deliberate:

- **Hull cards** (`src/ui/hullSelect.ts`). Every card prints a delta table folded through the
  real `src/sim/stats.ts`, signed by that table's own `lowerIsBetter` flag. So `HullDef.mechanism`
  carries no figures at all: it says what the hull is *for*, how it wants to be flown, and which
  mechanic its stat line interacts with — the things a table cannot say. Both halves are enforced:
  `tests/hulls.test.ts` fails on a figure in hull prose, and `tests/hullSelect.test.ts` fails if a
  figure the prose gave up is not printed by the table.
- **Item offer cards** (`src/ui/choiceScreen.ts`). The resolved before → after rows are the
  priority-1 information — "+45% damage" is +1.8 or +14 depending on what is already fitted — so
  the authored sentence is **dropped entirely** when the rows are strictly better: every stat the
  item moves has a row, and the item has no `effects`. An `effect` is behaviour a number cannot
  describe (extra projectiles, chaining, a timed window), so an item carrying one keeps its
  sentence. `flavour` is never dropped; it was never claiming to be a specification.

Note what is *not* changed by either: `ItemDef.mechanism` still states the numbers, because the
hangar prints it with no table underneath and it has to stand alone there. Dropping the sentence
is a per-card decision made by the screen that computed the figures, never an edit to the
content. `HullDef.mechanism` is the one that genuinely gives the figures up, and it can only do
that because the hangar does not show hulls — `HULL_SELECT_STANDFIRST` carries the baseline for
the Lien, whose card has no table.

**Check:** every item in `src/content/items.ts` has a mechanical line that names the numbers, and
no item's effect appears only in its flavour text. Every hull in `src/content/hulls.ts` has a
mechanical line that names *none*, and every figure it gives up is printed by the hull card. On
any screen, the numbers are legible somewhere on the option — in the prose or in the table, and
not in both.

## 5. Synergies are stated, not implied

When two held items interact, the game says so. On the item-choice screen, an option that
combines with something already held is marked, and the combined effect is spelled out.

**Why:** "hidden synergies players discover" is a fantasy that works for the 5% who read wikis.
For everyone else, undiscoverable interactions are indistinguishable from no interaction. The
depth is in *using* combinations, not in guessing they exist.

**Check:** for any pair of items with a defined interaction, the choice screen shows an
indicator and the interaction text when the second is offered.

## 6. Death to next run in two inputs

The death screen shows the run summary and a single obvious primary action. One key to confirm,
one to start the next sortie. No submenus, no navigating back to a main menu, no reload.

**Why:** a roguelike's core loop is "again". Every input between death and the next attempt is
friction applied at the exact moment the player is deciding whether to keep playing.

**Check:** from the incident screen, `confirm` calls `beginSortie()` directly (`src/main.ts`),
which is one press — two when `beginSortie` stops at hull select, which is the cap.

**Gap, honestly:** this was written as "a Playwright test dies, then reaches an active sortie in
≤2 key presses", and no such test exists. Playwright is a dev dependency used only by
`tools/screenshot.mjs`, `tools/perf.mjs` and `tools/audio.ts`; `npm test` is Vitest, and nothing
in `tests/` drives a browser. The rule holds by reading `main.ts`, which is not the same thing as
being enforced. Writing that test is the honest fix; until then this Check is a code reading.

## 7. Nothing below 11px effective, and never colour-on-colour

`Font.minSizePx` is enforced in `font()`. Body text is ≥13px at virtual scale; labels ≥11px with
wide tracking to stay legible small. All text meets WCAG AA contrast against the surface it sits
on — `textFaint` is the floor and is reserved for genuinely non-essential text.

**This rule was false for two milestones, and nobody could tell because nothing measured it.**
`textFaint` was 2.51:1 on the panel — failing AA *and* the 3:1 large-text floor — while being
drawn at 10px in the pause footer, and `danger` was 3.78:1 wherever it was used as text. Both
are fixed: `textFaint` moved to `#707F94`, and `danger` split into a separate `dangerText` token
because the mark and the glyph want opposite things (brightening the mark costs it the little
separation it has from `caution`; darkening the text is what broke AA). `tests/palette.test.ts`
now asserts every ratio against the surface each token is actually drawn on, so the claim above
cannot quietly become fiction again.

The honest consequence, worth knowing before designing another screen: **a three-step text ramp
cannot survive AA on a dark panel.** `#707F94` is the lowest value that clears it, and that lands
ΔE 4.7 from `textDim` — close enough that they stop reading as separate steps. Hierarchy below
`textDim` has to come from size and weight, not a third grey.

**Why:** the game is played in a browser window on unknown hardware, frequently a laptop at
100% zoom. Text tuned on a 27″ monitor is unreadable there.

## 8. The seed is always visible

Every sortie shows its seed in the panel footer. This makes any screenshot a reproducible bug
report, and any good run shareable without extra UI.

## 9. State changes are announced where the player is looking

The player's eyes are on their ship, not the panel. So a state change gets a brief, readable cue
near the ship *in addition to* updating the panel.

**Why:** a panel value that changes silently during combat is a value nobody sees change.

**What actually has a cue today:** a shield break ("SHIELD DOWN" at the hull, plus the ring going
out), scrap credited on a kill, damage taken, a boss phase change, and a hazard entering its
reaction window — the last of these because the panel row was the *only* announcement for two
milestones, which is this rule's failure mode in its purest form.

Two examples this rule used to name do not exist, and naming them was making the rule read as
already satisfied: **there is no weapon-change cue because no weapon can change** (`weaponName`
is the constant `'Twin Pulse'` in `src/main.ts` and no `SimEvent` reports a change), and **there
is no item-pickup cue because there is no pickup entity** — items are taken on the paused choice
screen, where the player is looking directly at what they picked. Both get a cue in the change
that makes them real; neither is a gap the interface can close first.

## 10. No blinking faster than ~1 Hz, no full-screen flashes

Pulses use a slow sine that never reaches zero opacity (see the title prompt). Impact effects
brighten and shake but never strobe the full screen.

**Why:** flashing in the 3–30 Hz range can trigger photosensitive seizures. This is a hard
constraint, not a stylistic preference. Screen shake is capped, and it *is* reducible: "Screen
shake" under Motion and light is a 0–100% setting that reads `Off` at zero, persisted as
`settings.shake` and threaded to the renderer as `SceneOptions.shakeScale`. `reduceFlashes` is
the separate control for modulation depth, and every pulsing effect is on the list
`tests/render.test.ts` sweeps for both.

---

## Screens

**Title.** Wordmark, one primary action, controls, seed, pilot number. No menu tree. Options
and daily-seed entry are one keypress away, not required to start.

**Sortie.** Playfield left, instrument panel right. Panel shows, top to bottom: pilot number and
hull name; integrity meter; shield meter and its reserve row; weapon, fire rate and scrap; sector
progress and wave; then one flexible region carrying hazards, the boss readout and the held
build, in that priority order; then the sortie log (kills, accuracy, hits); then the footer's run
mode and seed. Segmented meters — countable at a glance, unlike a smooth bar.

The flexible region is the only part that degrades, and it degrades threat-first: hazards drop
their prose and then their rows, the boss keeps its block, and the build — the one readout there
about a decision already made — yields last and collapses to a count. A player can check what
they are carrying between waves; they cannot check a hazard countdown after it has fired.

**Item choice.** Three options, full mechanical text, synergy markers, and the current build
visible so the choice can be made in context. Time is paused; this is a decision, not a
reflex test.

**Death.** What killed you, how far you got, what you unlocked, seed. One key to go again.

**Hangar (meta).** Unlocks as a flat readable list with real descriptions, not an opaque tech
tree. Locked entries state their unlock condition explicitly.
