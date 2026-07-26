# Mobile

M7 groundwork. The modules described here exist and are tested (`src/core/touch.ts`,
`src/core/viewport.ts`, `tests/touch.test.ts`, `tests/viewport.test.ts`) but are **not wired into
the running game** — nothing in `src/main.ts`, `src/render/**`, `src/ui/**` or `index.html` calls
them yet. This document is the design, the arithmetic behind it, the things it does not solve, and
the things this project's instruments structurally cannot check.

The decisions in the "Mobile support" section of `docs/DESIGN.md` are followed, not revisited:
relative drag, auto-fire always on, focus as a second thumb zone, and the frozen playfield aspect.
Where this document adds something, it is a mechanism for a decision already made.

---

## The constraint everything is built around

The playfield is **448×720 virtual units on every device, forever**. It is pinned in virtual units
by `tests/integration.test.ts` (`frozen playfield geometry`) and now in *screen* units by
`tests/viewport.test.ts`, which sweeps 15 container sizes × 4 inset profiles × 6 pixel ratios and
asserts the playfield lands at exactly 448:720 in all 360 of them.

A phone therefore gets a **smaller** view, never a different one. Everything below is about making
a phone work inside that, and the honest summary is: portrait costs the panel 61% of its area and
costs the player about a third of a hitbox radius of pointing precision. Neither cost is
negotiable away, because the alternative is that a seed, a daily contract, and a shared replay stop
meaning the same thing on two devices.

---

## 1. Control scheme: relative drag, and why the alternatives lose

**Chosen: relative drag** — the ship moves by the finger's *movement*, never to the finger's
*position*. The thumb is never on the ship, and lifting and re-planting is free.

The decisive number is the hitbox: a circle of radius **5.5 units** at the ship's centre (see
`HULL_COLLISION_RADIUS` in `src/sim/damage.ts` for why it is a quarter of the drawn silhouette).
The hull travels **3.5 units/tick** at base speed (210 units/s ÷ 60Hz), so one tick of committed
movement is 0.64 of a hitbox radius. Any input scheme has to place the ship to within a couple of
units or the game is unplayable.

| Scheme | Why it fails, in units |
| --- | --- |
| **Absolute touch** (ship = finger) | A thumb contact patch is 10–14mm. A 390-CSS-px-wide portrait fit spans a ~64mm screen, so 1 CSS px ≈ 0.164mm and the scale is 0.87: a 10mm thumb covers **~70 virtual units** — over 6× the ship's 11-unit hitbox diameter and ~3× its 22-unit drawn silhouette. You cannot see the bullet you are dodging. It also cannot be re-planted: lifting and touching down elsewhere teleports the ship. |
| **Absolute touch with a vertical offset** | Fixes occlusion, but the finger must then range over the full 720-unit height, and the bottom ~100 units of the playfield become unreachable because the finger would need to be below the screen. |
| **Virtual stick** | Velocity control, so position error **integrates**. To stop on a spot you must zero the stick at the right moment; at 3.5 units/tick the window to stop within one hitbox radius is ±1.5 ticks ≈ **±25ms**, against human release-timing variance of roughly 40–60ms. A stick systematically overshoots by more than a hitbox. Focus doubles the window to ~±58ms, which is only borderline. It also consumes a fixed corner of the playfield permanently. |
| **Relative drag** | Position control, so error does **not** integrate. `tests/touch.test.ts` asserts the guarantee directly: the ship lands within **half a tick's travel** (1.75 units, 32% of a hitbox radius) of where the mapping said, and within 0.79 units (14%) under focus. |

### Making a digital axis do position control

`InputSnapshot.moveX/moveY` are `-1 | 0 | 1` — deliberately, so a replay is one byte per tick.
There is no velocity to apply a "gain factor" to. So the controller keeps a **displacement debt**
in virtual units: the finger's delta × gain is banked as distance the ship still owes, and each
tick it emits an axis only when the debt is worth at least half a tick of travel, subtracting what
the ship will move.

Three details in that are load-bearing and each has a test with a verified mutant:

- **Diagonals.** `World.moveHull` normalises a diagonal to `step/√2` per axis. The controller
  drains the same reduced amount, or a diagonal drag over-delivers by 41%.
- **A ceiling on the debt** (4 ticks, 14 units). Without it a 200-px flick in 100ms banks ~460
  units of debt and flies the ship for another **2.2 seconds** after the thumb has stopped. The
  honest consequence of capping is that a flick faster than the hull can fly under-delivers — the
  hull has a speed limit and no input scheme can spend past it.
- **Lifting zeroes the debt.** A frozen last vector, or a debt that keeps draining, flies the ship
  into exactly what the player lifted their thumb to avoid.

Relative drag has no "wall stick" problem here, which is worth recording because it is the usual
bug in this scheme: the debt is drained by the *emitted intent*, not by observed movement, so
pushing into a wall drains the debt as fast as it arrives and reversing responds immediately.

### Gain: 2.0, and what it buys and costs

Gain is ship-screen-distance ÷ finger-screen-distance, so it is device-independent.

- **Reach.** Crossing the 448-unit playfield takes 224 units of finger travel — 195 CSS px on a
  390-px-wide portrait fit, about **32mm**. That is the top of one comfortable thumb sweep, and
  re-planting is free. Full height is 360 units of finger travel (~51mm), which needs a re-plant;
  that is normal and fine.
- **Precision.** The ship crosses its own 5.5-unit hitbox radius in **2.75 units** of finger travel
  — about **2.4 CSS px**, which is inside the jitter of a dragging thumb.

So the honest statement is: **at full gain, touch is not precise enough to thread a dense
pattern.** That is not a number to tune away — raising gain buys reach and directly costs dodging,
and lowering it makes a traverse take two thumb sweeps. It is what focus is for, below.

---

## 2. Auto-fire, and the choice card — the most important thing here

`docs/DESIGN.md` says auto-fire is always on, and it should be: a fire button in a shmup is pure
tax. But "always" has to mean "always during a sortie", and the reason is a specific, reproducible
softlock-shaped bug.

### What naive auto-fire does

`HELD_CONFIRM_DWELL_TICKS` in `src/sim/progression.ts` is the fix for a soft freeze a human tester
hit: confirming a reward card needs a *rising* fire edge so the card cannot flash past someone
already holding the trigger, which means anyone who never releases waits forever. The dwell lets a
held trigger confirm after 48 ticks so the game never stops responding. Its docstring says "in a
shmup the trigger is *always* held" — and on desktop that is a hazard the player can escape by
letting go of the key.

**On touch there is no key to let go of.** If the touch layer asserts `fire: true` unconditionally,
exactly two things can happen to every reward card, shop, and work order, and both are shipped
bugs. `tests/touch.test.ts` drives the real `updateCursor` to demonstrate each:

1. **The player does nothing.** The dwell fires at tick 48 and confirms **index 0**. Every card,
   every time, **0.8 seconds** after it opens. Mobile item pick rates collapse to "whatever is
   leftmost", and the same seed produces a different run on a phone than on a desktop — the
   competitive feature set stays *technically* reproducible (a replay is an input log) while
   quietly becoming meaningless as a comparison.
2. **The player touches the screen.** Any cursor navigation sets `awaitingRelease = false` and
   cancels the dwell. A trigger that never falls can never produce a rising edge, so the card can
   now **never be confirmed** — it runs to `CHOICE_TIMEOUT_TICKS` (60 seconds) and resolves as a
   **skip**. The reward is lost, and the game was unresponsive for a minute. This is strictly worse
   than the bug the dwell was written to fix.

### The fix, and where it belongs

Auto-fire is **contextual**. `TouchControls` carries a `TouchContext` of `'sortie' | 'choice' |
'menu'`, and only `'sortie'` asserts the trigger. On a card the touch layer emits `fire: false`,
which on the card's very first tick clears `awaitingRelease` and disables the dwell rescue —
correctly, because on touch nobody is stuck holding a trigger. A tap then produces a genuine rising
edge and confirms immediately.

**Do not "simplify" this back to an unconditional `fire: true`.** Four tests fail if you do, and
one of them exists purely to show what the dwell then does.

`HELD_CONFIRM_DWELL_TICKS` itself should **not change**. It is a keyboard rescue and it is still
correct for keyboards. The mobile answer is to not be in the state it rescues.

Two properties make the wiring forgiving:

- **A one-tick-late context switch is safe.** The app learns a card is open by reading
  `world.pendingChoice` *after* the tick that opened it, so exactly one sortie snapshot can leak
  onto a card. One tick of held fire is 47 short of the dwell. Tested.
- **Leaving a choice drops any queued input script and zeroes the debt**, so a card cannot deliver
  a stale confirm into the sortie behind it, and flying debt earned before the card cannot be
  delivered after it.

### Tapping a card option

The choice cursor lives in the simulation, which is right — a recorded run must reproduce its
picks — but it means an absolute tap on the third card cannot select the third card directly. So
`scriptSelect(from, to, optionCount)` queues the discrete pulses a keyboard would have produced:
a leading neutral tick (the cursor starts every card with every button considered already-held),
then alternating neutral/direction pulses taking the shorter way round the wrap, then a confirm.
The longest walk on a three-option card is **5 ticks — 83ms**, which reads as a direct tap.
`scriptSkip()` does the same for a decline.

This keeps the sim untouched: no new state, no new input fields, no risk to determinism, and a
replay recorded on a phone is byte-identical in shape to one recorded on a keyboard.

**What is not solved:** the mapping from a tap's screen position to an option index needs the
card's hit rectangles, which live in `src/ui/choiceScreen.ts`. That is the wiring agent's job.

---

## 3. Focus

`docs/DESIGN.md` commits to "focus as a second thumb zone". The mechanism chosen is **any second
finger on the playfield**, rather than a fixed rectangle.

**Why a whole-surface zone rather than a button.** A fixed focus button either sits in the
playfield — where it permanently occludes play area and competes with the steering thumb for the
same corner — or in the panel, where on a portrait phone it is on the wrong side of the screen for
whichever hand is not steering. A second finger anywhere is reachable with either hand, consumes no
real estate, and cannot be covered by the steering thumb. `TouchControls` still accepts an optional
`focusZone` rect if a later playtest wants the explicit button instead; the default is "anywhere".

**Focus scales the gain, not just the step.** This is the part that is easy to get wrong. In a
displacement-debt controller, making only the per-tick step smaller does not make aiming finer — it
delivers the same distance more slowly, which is *lag*, not precision. So focus multiplies both the
gain and the drain rate by `focusFactor` (0.45). The effect:

| | finger travel per hitbox radius | landing error |
| --- | --- | --- |
| normal | 2.75 units (~2.4 CSS px) | ±1.75 units (32% of a radius) |
| focus | 6.11 units (~5.3 CSS px) | ±0.79 units (14% of a radius) |

2.2× the pointing room, past the thumb-jitter floor, and — asserted by a test — **no extra
latency**: the settle time in ticks is identical, because both terms scaled together.

**What is not solved:** focus has no visual affordance. A player who never tries a second finger
never finds it, and nothing on screen suggests it. That is an onboarding problem (M6/M7's "replace
keyboard-assuming UI text") and it is a real gap, not a detail.

**A genuine blocker, flagged for whoever wires this:** `index.html` sets `touch-action:
manipulation`, which suppresses double-tap zoom but **still permits pinch-zoom**. A two-finger
gesture on the canvas will be eaten by Safari as a pinch. The canvas needs `touch-action: none`
before the two-finger focus mapping works at all. That is a one-line change in a file this work did
not own.

### The alternative that was considered and rejected

**Speed-derived focus** — engage focus automatically when the thumb is moving slowly. It is
tempting for a second reason: at 50% duty cycle the digital axis alternates on/off at 30Hz, and a
smaller step makes slow movement smoother as well as finer. It was rejected because it is an
*implicit mode change*. The player would feel the ship's response change with no cause they can
name and no way to hold or release it, which is the "confusing HUD is a P0 bug" rule applied to
feel. Recorded here rather than deleted, because if the second-finger mapping tests badly on a real
device this is the first thing to try instead.

---

## 4. Viewport, scaling, and the panel

`src/core/viewport.ts` is pure arithmetic and holds no DOM: `src/render/layout.ts` owns canvas
mutation, this owns the numbers, so they can be tested headless and reused to map touches back into
virtual units.

**Two layout modes, and the mode is chosen by measurement.** Landscape composes 640×720 (playfield
448 + panel column 192). Portrait composes 448×840 (playfield 448×720 + a **120-unit** panel bar
beneath). `fitViewport` computes both scales and takes the larger, which does the right thing for a
phone either way up, a tablet, a desktop window of any shape and a split-screen pane without
special-casing any of them. A 6% hysteresis band stops a near-square container thrashing between
placements on every resize event.

On the 390×844 phone `docs/DESIGN.md` names, this produces exactly the arrangement recorded there:
scale 0.8705, playfield **390×627**, a **104 CSS px** panel bar, **731 of 844** pixels used. That is
pinned by a test.

**What the portrait panel costs, stated plainly.** The landscape column is 192×720 = 138,240 square
units. The bar is 448×120 = 53,760 — **39% of the area, a 61% loss**. Portrait cannot show the same
panel content at the same type size, and UI rule 7's hard 11px floor means shrinking the text is
not an escape. `src/render/panel.ts` will need a genuinely different portrait composition, not a
reflow. A test asserts the ratio so the number cannot drift unnoticed, and asserts the bar never
overlaps the playfield (UI rule 1).

**Device pixel ratio is capped at 2, with a 2.4-megapixel backstop.** Fill cost is quadratic and
the additive `'lighter'` glow pass pays it twice; `docs/ROADMAP.md` names glow at 3× DPR on a
mid-range phone as M7's specific performance risk. A 3× phone costs 2.25× the fill of a 2× one for
a difference almost nobody can resolve at that size. The pixel backstop matters on desktop too: a
maximised window on a 4K display is 16.6 megapixels of canvas at 2×, an order of magnitude past
anything the frame budget was ever measured against. The cap never reduces below 1 device pixel per
CSS pixel — a soft canvas traded for a frame budget is the wrong side of UI rule 7.

**Adopting the cap changes what the game looks like on high-DPI displays and therefore needs a
reviewed screenshot** before it goes in. `src/render/layout.ts` still uses the raw ratio.

**Safe-area insets** are subtracted before fitting and the canvas is centred inside what remains,
so the fit *shrinks* rather than *shifts* — a home indicator must never push the playfield off the
bottom. Swept over four inset profiles. Reading `env(safe-area-inset-*)` is the caller's job;
`index.html` already sets `viewport-fit=cover`, which is the prerequisite.

**Letterbox touches are reported as outside the playfield, not clamped.** Clamping would make a
thumb resting on the bezel read as a thumb on the edge of the play area — in relative drag, a
phantom finger that steers.

---

## What is still open

- **The panel's portrait composition.** 61% less area. Deciding what to drop or restack is a UI
  design job, and it is the largest remaining piece of M7.
- **Where a tap on a choice card maps to an option index.** Needs hit rects from
  `src/ui/choiceScreen.ts`.
- **`special` has no touch gesture during a sortie.** Nothing in the shipped game uses it in flight
  yet, but the moment something does, it needs one.
- **Pause on touch.** `Escape`/`P` has no equivalent. Auto-pause on `visibilitychange` already
  covers the common phone case (a call, a notification, switching apps), but a deliberate pause
  needs an affordance, and it must not be reachable by accident mid-dodge.
- **Discoverability of two-finger focus.** No affordance exists.
- **Whether gain 2.0 is right.** It is derived, not measured. See below.
- **Mode-flip during a run.** Rotating a phone mid-sortie relayouts the panel. The playfield is
  unaffected and the sim never notices, but it is visually abrupt.
- **`touch-action: none`** on the canvas, and `overscroll-behavior: none` — both in `index.html`,
  both already listed in `docs/ROADMAP.md` M7.

---

## Blind spots — what cannot be verified here

In the tradition of `docs/VERIFICATION.md` §5, which is honest about audio having no instrument.
**Touch has the same problem and it is worse, because the thing being judged is a physical
sensation.**

What *is* verified: 60 headless tests, all of the movement arithmetic, the multi-touch rules, the
auto-fire/choice-cursor interaction driven through the real `updateCursor`, and the viewport
geometry over 360 device/inset/DPR combinations. Thirteen deliberate mutations of the source were
each caught by at least one test, including all four of the auto-fire, debt-ceiling, diagonal, and
frozen-aspect properties.

What is **not** verified, and should be read as engineering judgement rather than fact:

- **Whether gain 2.0 feels right.** The 32mm-traverse and 2.4-px-per-hitbox-radius figures are
  arithmetic from a thumb model, not from a thumb. This is the highest-risk number in the file and
  the most likely thing to be wrong.
- **Whether relative drag is learnable without instruction.** The reasoning against a virtual stick
  is sound and the genre agrees, but "a player picks this up in ten seconds" is an assumption.
- **Whether a second finger reads as "focus".** Nobody has tried it. It may simply not occur to
  anyone.
- **Whether the tap-slop dead start (3 units) is invisible or feels like lag.**
- **`attachTouch()` — the entire DOM translation layer.** Pointer-event coalescing, whether
  `pointermove` arrives at 60Hz or 120Hz or in bursts, iOS gesture interception, `pointercancel`
  behaviour when a system gesture steals the touch, palm rejection. All of it is a translator that
  needs a real touchscreen to exercise, and none of it is under test.
- **Whether the frame budget survives.** No mobile GPU has run this. The DPR cap is a mitigation
  for a risk that has not been measured.
- **Whether 104 CSS px of panel bar is legible at arm's length**, and whether `tests/textFits.ts`'s
  container measurements still hold in a portrait composition that does not exist yet.
- **Anything about a real device at all**: notch geometry in practice, the iOS home-indicator swipe
  competing with a drag near the bottom edge, thermal throttling, or Safari's handling of a canvas
  that is 448 CSS px wide at 2× on a 3× screen.

The instrument that would close most of this is a Playwright run in a mobile emulation profile
driving synthetic touch sequences against the real build — it would cover `attachTouch`, the
CSS-level gesture suppression, and the portrait layout in a screenshot. It would still not tell us
whether gain 2.0 feels good. That needs a thumb.
