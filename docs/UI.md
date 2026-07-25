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
being state readouts: floating damage numbers, pickup labels, boss-phase callouts, and the
lock-on/threat indicators for off-screen enemies.

**Check:** no call in `src/render/panel.ts` or `src/ui/**` draws at `x < PLAYFIELD_W` during a
sortie.

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

**Check:** `danger` appears in the codebase only for enemy fire, incoming damage, lethal
hazards, critical resource states, and death.

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

**Check:** every item in `src/content/items.ts` has a mechanical line that names the numbers,
and no item's effect appears only in its flavour text.

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

**Check:** a Playwright test dies (or forces a death), then reaches an active sortie in ≤2 key
presses.

## 7. Nothing below 11px effective, and never colour-on-colour

`Font.minSizePx` is enforced in `font()`. Body text is ≥13px at virtual scale; labels ≥11px with
wide tracking to stay legible small. All text meets WCAG AA contrast against the surface it sits
on — `textFaint` is the floor and is reserved for genuinely non-essential text.

**Why:** the game is played in a browser window on unknown hardware, frequently a laptop at
100% zoom. Text tuned on a 27″ monitor is unreadable there.

## 8. The seed is always visible

Every sortie shows its seed in the panel footer. This makes any screenshot a reproducible bug
report, and any good run shareable without extra UI.

## 9. State changes are announced where the player is looking

The player's eyes are on their ship, not the panel. So a shield break, an item pickup, or a
weapon change gets a brief, readable cue near the ship *in addition to* updating the panel.

**Why:** a panel value that changes silently during combat is a value nobody sees change.

## 10. No blinking faster than ~1 Hz, no full-screen flashes

Pulses use a slow sine that never reaches zero opacity (see the title prompt). Impact effects
brighten and shake but never strobe the full screen.

**Why:** flashing in the 3–30 Hz range can trigger photosensitive seizures. This is a hard
constraint, not a stylistic preference. Screen shake is capped and will be reducible in
settings.

---

## Screens

**Title.** Wordmark, one primary action, controls, seed, pilot number. No menu tree. Options
and daily-seed entry are one keypress away, not required to start.

**Sortie.** Playfield left, instrument panel right. Panel shows, top to bottom: pilot number and
hull name, integrity meter, shield meter, weapon and fire rate, scrap, sector progress, seed.
Segmented meters — countable at a glance, unlike a smooth bar.

**Item choice.** Three options, full mechanical text, synergy markers, and the current build
visible so the choice can be made in context. Time is paused; this is a decision, not a
reflex test.

**Death.** What killed you, how far you got, what you unlocked, seed. One key to go again.

**Hangar (meta).** Unlocks as a flat readable list with real descriptions, not an opaque tech
tree. Locked entries state their unlock condition explicitly.
