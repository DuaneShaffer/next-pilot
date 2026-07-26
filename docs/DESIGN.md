# Game design

## Premise

You are contract labour for the Salvage Division. The hull is company property. You are not.

Each sortie sends a pilot down a corridor of wrecked space to recover whatever is still worth
money. When the hull is destroyed, the run ends permanently, the incident is filed, and the
company calls the next pilot. Meta-progression is the *company's* growing equipment roster and
the accumulated data your predecessors died collecting — not your personal power.

**Tone: deadpan institutional.** The humour lives in memos, requisition forms, incident reports,
and performance reviews written about your corpse. It never appears in functional UI text, where
clarity wins outright (see `docs/UI.md` rule 4). "Laser Tax Evasion" is a joke that gets old;
a hazard-pay dispute filed on your behalf posthumously stays funny.

## The core loop

```
Title → Hull selection (3 randomised offers) → Sector run → Work order (route choice)
   → … five sectors … → Extraction or death → Incident report → Certifications → again
```

A full successful run should take **15–20 minutes**. Long enough for a build to develop, short
enough that a death isn't an evening wasted.

## Hulls

Company hulls are named after legal and financial instruments. It's a cohesive naming system that
carries the tone without needing a joke per item.

Each hull is defined by a **drawback that shapes play**, not just a stat spread. A hull that is
strictly worse is a hull nobody picks.

| Hull           | Character                | Drawback that defines it                                     |
| -------------- | ------------------------ | ------------------------------------------------------------ |
| **Lien**       | Balanced starter         | None. The baseline everything else is measured against.       |
| **Arrears**    | Fast, fragile, funded    | Starts with bonus scrap; elite enemies spawn more often.      |
| **Surety**     | Heavy, shield-forward    | Slow. Converts absorbed shield damage into weapon charge, so it *wants* to be grazed. |
| **Escrow**     | Drone carrier            | Weak main gun. Drones inherit weapon upgrades but can be lost permanently mid-run. |
| **Probate**    | Inherits a dead pilot's relic | Starts with a random relic and reduced max integrity.    |
| **Indemnity**  | Deferred damage          | Damage taken is applied on a delay, so mistakes are survivable but compound. |
| **Writ**       | Phase dodge              | Can phase through bullets briefly; firing shortens the phase window. |
| **Collateral** | Sacrificial              | Can permanently disable its own systems mid-run for large power spikes. |

Three are offered per run, drawn from what's been certified. `Lien` is always available.

### What actually shipped, and what each missing hull is waiting on

Five of the eight exist as of M5. The other three were **omitted rather than approximated**, for
the same reason the rejected synergies below are recorded rather than deleted: a hull whose stated
drawback does not actually happen is worse than an absent hull, because it ships looking finished.
`HULLS_AWAITING_MECHANICS` in `src/content/hulls.ts` carries this list as data, and a test requires
every certification that grants a hull to point at either a real hull or a named entry in it — so
the gap fails loudly the moment it is forgotten instead of quietly.

| Hull | Status | What it needs |
| --- | --- | --- |
| **Escrow** | Not shipped | Drone entities. Nothing in the sim spawns a *friendly*; the `drone` item tag exists and nothing reads it. |
| **Indemnity** | Not shipped | A deferred damage queue in `sim/damage.ts` — damage enqueued with a due tick, visible on the HUD while pending, reducible in between. `applyHullDamage` subtracts immediately and no `EffectKind` holds state across ticks. |
| **Writ** | Not shipped | A player-triggered phase state: a new input action (`InputSnapshot` is the whole contract), a charge firing consumes faster, and a readout. `HULL_INVULN_TICKS` is damage-triggered, not player-triggered. |

Three more shipped with the **drawback intact and part of the upside missing**, which is stated in
the code and never on the card the player reads:

- **Arrears** — "elites spawn more often" is unwritable: `HullDef` has no spawn-table hook. Its
  fragility carries the risk instead, and its mechanism text does not claim elites.
- **Surety** — shield-to-weapon-charge conversion needs an `onShieldAbsorbed` hook, already
  recorded below as missing. Paid up front as flat damage instead.
- **Probate** — "a random relic" needs a starting-item *pool* and its own RNG stream. It starts
  with a named relic and says which one.

### Route choice between sectors — as built

The world map is a card between sectors offering 2-3 **approaches** into the next one. The sector
order never varies, so a route cannot let a player skip the difficulty curve; what varies is the
price of arriving well-equipped. Each non-direct route arms a hazard for the whole of the next
sector and pays for it once on arrival — an item or a repair, stated with real numbers. Both are
quantities the pilot reads off their own panel; **scrap was tried as a third payout and removed**,
see "Route rewards are priced off the panel" below.

The direct approach is always first and always free. A risk/reward screen with no safe option is
not a choice, it is a tax. And a sector with no hazards to trade against shows **no card at all**,
because a card whose only action is "continue" teaches the player that stopping is pointless —
which is the exact mistake the unbuyable wave-8 shop made.

`vault` (a relic with a curse attached) and `unlisted` (unknown modifiers, higher certification
chance) from the work-order list below are **not implemented**. Vault needs curse items to attach;
unlisted needs certification odds to be a run-time quantity rather than an outcome.

## Sectors

Five sectors, each with a distinct enemy grammar so the run has texture rather than escalating
sameness.

1. **Debris Shelf** — sparse, slow projectiles. Teaches pattern reading. The tutorial that isn't
   labelled a tutorial.
2. **The Tally** — corporate convoy lanes. Turrets and escorts, high scrap yield. Greed vs safety.
3. **Bloomfield** — something organic has taken a dead station. Corrosive, spreading, irregular
   patterns that punish standing still.
4. **Kill Grid** — automated defence net. Precise laser geometry, telegraphed and unforgiving.
   Positional, almost puzzle-like.
5. **The Deep Manifest** — the wreck you were actually sent for. Boss, with seeded variants.

### Work orders (routing)

Between sectors you choose one of 2–3 assignments. Each states its trade-off in plain language —
no guessing what an icon means:

- **Supply run** — a shop with more stock. Safer, costs scrap.
- **Hazard bonus** — an elite encounter. Rare item on completion.
- **Vault contract** — a sealed vault. A relic, and a curse attached to it.
- **Repair dock** — restores integrity. No reward.
- **Unlisted** — unknown modifiers. Higher certification chance.

## Route rewards are priced off the panel — decided 2026-07-26

**No route pays scrap any more.** The two priced approaches pay a build slot (one item, chosen
from three) or integrity (+60% of maximum, capped at maximum), and nothing else. The card used to
offer a currency, a free item and a heal side by side, which is three different kinds of thing,
and a player could only price one of them.

**The measurement is what settles it, and it is not close.** Five bot policies × 60 seeds × the
full five-sector run, instrumented at every card:

| | leg 2 | leg 3 | leg 4 | leg 5 |
| --- | --- | --- | --- | --- |
| scrap held when the route card opens | 560 | 2,030 | 3,463 | 5,474 |
| what the scrap route paid | 125 | 180 | 235 | 290 |
| scrap held at a shop | 1,579 | 2,755 | 4,653 | 8,726 |
| dearest thing on sale | 220 | 224 | 272 | 220 |

Every shop from leg 2 on is bought from at 97–100%, and **100% of runs end with scrap unspent**,
median 3,940. A pilot at the last seam is being offered 5% of what they already cannot spend. Take
rate confirmed it: with every policy told to take the best-paying route, the item won 80–90% of
the cards it appeared on. **A choice with a standing right answer is not a choice.**

**Why not make scrap scarce instead**, which is the root-cause fix and was the first option
considered: holdings span **43x across a run** (257 at the first shop, 8,726 at the last), and the
dominant sink — the two in-sector shops per sector — is priced by `shopCosts`, which is handed a
per-sector `waveIndex` and cannot see absolute run progress. One curve cannot bite at both ends,
and the leg-1 shop is *already* declined 29% of the time, which is the direction the unbuyable
wave-8 shop failed in. Making scrap matter is a real change and a good one, but it is a change to
what the run *spends scrap on*, not to what a route pays. Whoever takes it needs an absolute
progress measure in `shopCosts` or a second sink; `RouteReward` keeps its `scrap` variant, and
`SALVAGE DETOUR` keeps its name, for that day.

**What makes the two survivors commensurable** is that both are read off the pilot's own
instruments. An item is a slot in a build the player can see; a repair is the gap in the integrity
meter they have been watching for fifteen minutes. Neither has a fixed value — **which one is
correct is a fact about the pilot's state, not about the card**, so no amount of learning turns
this screen into a reflex. The repair went from 35% to 60% of maximum integrity because the old
number could never be right: scored the way a build-aware policy scores it (an item ≈ 50 points of
damage healed), 35% of even a 140-point hull is 49 — below the crossover on every hull in the
game at every damage level. At 60% the crossover lands at "you have lost more than half a hull",
and how often that happens is a property of how you fly: measured, 48% of route cards for the
evasive policy, 27% for the greedy one, 7% for the clear-speed benchmark.

**Measured after, same probe** (every policy told to take the best-paying route). Share of route
cards where each payout was taken:

| | item before | item after | non-item before | repair after |
| --- | --- | --- | --- | --- |
| evasive (`dodger`) | 80% | 68% | 29% scrap / 13% repair | **32%** |
| clear-speed (`aggressor`) | 90% | 90% | 21% / 1% | 10% |
| greedy | 83% | 82% | 23% / 12% | 18% |
| build-chaser | 87% | 96% | 26% / 2% | 4% |
| control (`random`, n=5) | 80% | 20% | 0% / 25% | **80%** |

The item is still the usual answer for a pilot who is not being hit — as it should be, that pilot
has nothing to spend a repair on. What changed is that **the answer now moves with the pilot**: 4%
to 80% across policies, against a "third option" that used to be arithmetically incapable of
winning. The direct approach is taken 100% by the two policies that fly it by default and about a
third of the time by the uniform control; the risk-appetite probe never takes it, because
`routeScore` prices rewards and not hazards and says so.

**Do not read a clear-rate delta off this change yet.** Other sim work was landing during the
sweeps — `world.ts`, `damage.ts` and `entities.ts` all changed mid-run, and the clear-speed
benchmark's *direct-route* rate (which no route reward can touch) moved from 80% to 42% between
sweeps on its own. Take-rate reproduced across three sweeps and two seed bases; clear rate is not
comparable until the tree settles and wants re-measuring after the `SIM_VERSION` bump.

**One price, stated once (finding #33).** `buildRoutes` gives both priced routes the same hazard
whenever the next sector has only one, and **three of the four seams in the shipped run are that
case** — only The Deep Manifest carries two. The rows printed that hazard's name twice and the
card read as though it had drawn the same row by mistake. The sim is right and the screen was
wrong: the choice there really is purely the reward. So when every detour on a card accepts the
same hazard, the world map hoists the price into one line above the rows and each row spends its
second line on what it pays. The alternatives were rejected for stated reasons: collapsing to a
single priced route deletes the item-versus-integrity decision at three of the four seams, and
differentiating by hazard *intensity* would need a second near-identically-named hazard per
sector, which trades one duplicate-looking row for two.

**Two things it fixes for free:**

- **The card can be compared without moving the cursor.** All three payouts are now on the rows in
  the simulation's own words, where previously two rows spent that line repeating one hazard.
- **`bots.ts` becomes an honest oracle again.** It already scored a repair against damage actually
  taken, so its route preference now varies by policy instead of resolving to "take the item".

**What must not change:** the direct approach stays first and stays free — a risk screen with no
safe option is a tax, not a decision. And `rewardText` stays the single source of the sentence, so
the map cannot describe a payout the sim will not pay. It is a sim change, so `SIM_VERSION` bumps
and the replay corpus needs a proved re-base.

## The shield recharges — decided 2026-07-26

**A shield that never comes back is not a shield, it is a second, smaller health bar.** It was
built as a one-off buffer in M1 (`applyHullDamage`: "absorbs first and does not regenerate") and
that reading has never been revisited. The name has been writing a promise the mechanic does not
keep for four milestones.

So: **shields recharge.** The consequences are worth stating before anyone implements it, because
this is not a small change.

**It reshapes what damage means.** Right now every point of damage is permanent, so the only
questions are "how much can I take" and "can I heal". A recharging shield adds a third: *how long
since I was last hit*. That is a genuinely different skill — disengaging becomes a play rather
than a delay — and it is the axis the game currently has none of.

**It interacts with the two structural findings already measured, and both cut the same way:**

- **Integrity recovery is the game's dominant variable.** One recovery relic multiplies the clear
  rate by 1.9–2.6× (**re-measured after the recharge shipped: ×1.97, and ×2.59 with recovery off —
  see below**). A recharging shield is a *second* recovery source, permanently available to
  every hull, so it cannot be tuned by feel — it has to be measured against that number, and the
  recharge rate is likely to be the single most sensitive constant in the game.
- **Boss bullet density is inert**, because the 45-tick invulnerability window caps intake at 1.33
  hits/second. A recharge that outpaces that cap makes the pilot invulnerable to any pattern
  below it; one that does not is nearly free to ignore. The window between those two is narrow and
  needs finding by measurement, not by taste.

**Items for it, which is what makes it a system rather than a stat.** `maxShield` already exists as
a `StatKey`; recharge needs at least a rate, and probably a delay-before-recharge, since those two
are the levers that let a shield item be *cursed* (fast recharge, tiny pool; huge pool that takes
ten seconds to start). The `StatKey` union is deliberately closed, so this is two new keys and the
bounds that go with them.

**Two things it fixes for free**, which is part of why it is right:

- **Surety finally works as designed.** `docs/DESIGN.md` gave it "converts absorbed shield damage
  into weapon charge, so it *wants* to be grazed", and that shipped as flat damage because there is
  no `onShieldAbsorbed` hook and, more fundamentally, because a non-recharging shield can only be
  grazed a fixed number of times. A recharging shield makes the fantasy playable.
- ~~**`retaliation-coil`'s anti-synergy stops being a trap.**~~ **Wrong, and the first correction of
  it was also wrong.** Worth reading as a pair, because the same mistake was made twice in one day
  from opposite directions.

  The original claim was that recharge turns shield capacity and retaliation from a mistake into a
  real trade. It was replaced within hours by the opposite claim — that recharge makes the coil
  *strictly worse*, since the coil fires only on integrity loss and a recovering shield means
  integrity is hit less often. That reasoning is sound and the trigger count does fall: across five
  policies and four seeds, `retaliate` fired in three runs of twenty where it had fired reliably
  before.

  **Neither claim survives a clear-rate measurement.** Ablated properly — 900 runs per arm across
  three seed bases — the coil is worth **+2.1pp against a 2.2pp standard error**, and ×1.04/×1.00/
  ×1.00 with recovery switched off. It was already inside the noise, so the recharge had nothing to
  take away. Both predictions were reasoning about a *mechanism* and calling it an effect on the
  *game*; the trigger count moved and nothing the player can feel did.

  Kept struck through rather than deleted, because both wrong thoughts are intuitive and someone
  will have one of them again. The lesson is the third one: a change in how often a thing fires is
  not a balance finding until it is measured against the clear rate.

**What must not change:** the shield still absorbs before integrity, so `applyHullDamage` keeps one
damage path; and recharge is simulation state, so it ticks in whole ticks off the run seed like
everything else. It is a sim change, so `SIM_VERSION` bumps and the corpus needs a proved re-base.

### As built — and the measurement corrected the design above

Implemented 2026-07-26. **The prediction in this section was wrong about the lever, and the numbers
are worth keeping because being wrong here was cheap and being wrong later would not have been.**

The section above says the danger is a rate that outpaces the 1.33 hits/second intake cap, and that
the job is to find a narrow band between "too fast to matter" and "too slow to notice". Measured
against the `aggressor` policy over 60 five-sector runs, with a 15% baseline for no recovery and the
M5 exit band at 20-40%, **that band is empty**:

| Configuration | Clear rate |
| --- | --- |
| recovery off (the shipped M5 game) | 15% |
| 4/s, 2.5 s delay | 76% |
| 4/s, **15 s** delay | 60% |
| 1/s, 2.5 s delay | 75% |
| 0.25/s | 48% |
| 0.1/s — one full pool per six and a half minutes | 30% |

Two things fall out. **The delay is not the safety lever** — stretching it six-fold barely moved the
number, because a 15-20 minute run contains plenty of gaps longer than any delay worth shipping. And
**there is no rate that is both visible and balanced**: 0.1/s is inside the band and is also
invisible, refilling one shield per six minutes while still doubling the clear rate in aggregate.
Statistically decisive and experientially absent is the worst available outcome, and it is what a
purely time-based recharge forces. The integral, not the rate, is what matters, and elapsed time is
the wrong denominator for it.

**So recovery is bounded by progress instead of by the clock.** A `shieldReservePerSector` budget
(base 15) refills on sector entry and is spent one point per point recovered. That fixes the units:
the most recovery can ever contribute is five reserves, 75 points against a 100-point hull, which is
a number the difficulty curve can be tuned against. And because the total is bounded, the *rate* is
free to be fast enough to feel — 4/s, so half a shield comes back in four seconds of not being hit.

The row that shows the mechanic earning its keep is `0.1/s` against `reserve 20`. Both allow ~100
points across a run; the reserve version measures 12pp stronger, because the same total is worth
more when the player chooses where it lands. That is the "disengaging becomes a play" claim above,
finally true and finally measurable. Shipped at 15/sector, which measures 33-35%.

Consequences recorded honestly:

- **The rate cap is not a safety mechanism and must not be mistaken for one.** `Cycling Array` is
  12/s by design, while the rate that could not out-heal even the weakest 6-damage shot across one
  invulnerability window is under 7.8/s. The guarantee against recovery running under sustained fire
  is the delay's `min: 60` floor sitting strictly above the 45-tick invulnerability window.
  `tests/shield.test.ts` asserts the rate cap is *insufficient*, so nobody tightens it and believes
  they have fixed something.
- **An unspent reserve does not carry forward.** Banking it would reward the sector you found easy
  with a buffer in the one you found hard, inverting the curve the reserve exists to respect.
- **Three new `StatKey`s, not two** as predicted above: rate, delay, and the reserve.
- **It quietly weakened every integrity-triggered effect, and that was nearly missed.** A shield
  that recovers means integrity is hit less often, so `retaliate` (fires on integrity loss) and
  `repairOnKill` (does nothing at full integrity) both lose most of their triggers. Measured across
  five policies and four seeds: `repairOnKill` fired in **zero** runs and `retaliate` in three of
  twenty; with recovery switched off, both fire reliably on the same seeds. That matters beyond two
  items — **Repair Nanites is the strongest relic in the game**, and it is now working against a
  hull that takes less integrity damage.

  **Re-measured, 900 runs per arm across three seed bases (2026-07-26): ×1.97, down from ×2.59
  with recovery switched off on the same seeds.** So the recharge did cost the relic roughly a
  quarter of its edge — the old 1.9–2.6× band's top end is now the recovery-off figure. It is still
  by a distance the dominant variable: +30.6pp against shield recovery's own +13.3pp ablation, so
  one relic is worth about three shields.

  The trigger-count observation that started this stands; the conclusion drawn from it did not
  transfer to `retaliation-coil`, which turned out to be inside the noise either way. See the
  struck-through bullet above — a change in how often something fires is not a balance finding
  until it is measured against the clear rate.

  What caught it: the replay corpus's effect-coverage check, which removes each probe item and
  fails if the run is unchanged. Holding an item proves nothing; that check demanded the effect
  actually fire, and refused a fixture claiming seven-of-seven while proving five. The probe hull
  now switches recovery off so the bus stays covered — see `tests/replays/content.ts`.
- Not yet done: the reserve is simulation state and the HUD does not show it. A recovery budget the
  player cannot see is a budget they cannot plan a disengage around, which is most of the point.

## Items and synergy

**Design position: ~40 well-connected items beats 150 stat sticks.** The depth players actually
feel comes from combinations, and a combination is only fun if it's discoverable. So every item
carries explicit **interaction tags**, and the choice screen names interactions when it offers
them (UI rule 5).

Every item must pass this test: *can a player, reading only the item's own text, predict what it
does?* If not, it needs rewriting, not more flavour.

Example interactions, chosen to reward different playstyles:

| Combination                      | Result                                                     |
| -------------------------------- | ---------------------------------------------------------- |
| Split Shot + Arc Coupler         | Each split fragment can chain lightning to a nearby target. |
| Overkill Accounting + Warheads   | Excess damage on a kill converts to scrap.                 |
| ~~Retaliation Coil + Heavy Shield~~ | **Backwards — do not ship.** See below.                 |
| Drone Uplink + Mirror Mount      | Drones fire a weaker copy of your main weapon.             |
| Heat Sink + Overclocked Beam     | The beam's overheat penalty becomes a sustained beam.       |
| Graze Reactor + Phase Window     | Near-misses charge your special, rewarding dangerous flying. |
| Scrap Magnet + Coin-Op Cannon    | Collecting scrap briefly raises fire rate — a greed engine. |
| Cursed Hull + Repair Nanites     | Lower max integrity, but every repair also grants damage.    |

### Combinations this list got wrong

Kept rather than deleted, because the reasoning is the useful part.

**Retaliation Coil + Heavy Shield is an anti-synergy.** The only damage hook fires *after* shields
absorb, so a bigger shield means strictly *fewer* retaliation triggers. Shipping it would have put an
anti-synergy behind a synergy marker — telling the player two items combine while they actively
work against each other, which is worse than no marker at all. Expressing it needs an
`onShieldAbsorbed` hook that M3 does not have. The coil is paired with **Cursed Hull** instead
(fewer hit points, so more triggers), which is the same fantasy pointing the right way.

Three more from the original list are not expressible yet, and are waiting on mechanics rather than
on items:

- **Heat Sink + Overclocked Beam** needs a beam weapon and an overheat resource. No `EffectKind`
  accumulates and vents.
- **Graze Reactor + Phase Window** needs a near-miss event and a chargeable special. Neither a graze
  hook nor a special meter exists.
- **Drone Uplink + Mirror Mount** needs drone entities. The `drone` tag exists; nothing spawns one.

**Cursed Hull + Repair Nanites** shipped only partially: "every repair also grants damage" is a
*stacking* buff, and no `EffectKind` holds state across triggers. The delivered version is a flat
damage bonus plus a much larger repair — the same build, without the ramp.

The lesson worth keeping: a synergy list written before the effect system exists will contain
combinations the system cannot express, and a few that are actively wrong. Check each against the
hooks that exist before promising it to a player.

## Progression

**Certifications** are the permanent unlocks. They expand *variety*, not raw power — a roguelike
that gets easier with playtime stops being interesting. Certifications add hulls, weapon
families, item families, enemy types, boss variants, and work-order types to the pool.

**Personnel files** record every dead pilot: hull, cause of loss, depth, seed. It's a run history
that doubles as the game's writing surface — a browsable list of institutional indifference.

Explicitly **not** included: currency-purchased permanent stat upgrades. They convert a skill
problem into a grinding problem.

## Proposals not yet decided

Recorded so they are not lost, and explicitly NOT settled design. Nothing below is
implemented or scheduled.

### Experience and levels

A second progression axis alongside items, proposed 2026-07-25.

The design question is not whether it is possible but what makes it **distinct from
items**. Items arrive twice a sector as a considered three-option choice. If levels
also present a considered choice they are the same system at a different interval,
and two power curves doing one job dilute both.

Where it would earn its place: **high frequency, low deliberation** — a level every
~15 kills granting one small immediate pick, so the sector has continuous growth
between its two big decisions. What to avoid is a level opening another three-option
card.

### World map and between-sector shops — SETTLED, built in M5

Resolved as predicted: these were never new systems, only the existing work-order
design finally having somewhere to live. See "Route choice between sectors — as built"
above for what shipped, including the two work-order kinds that did not.

One loose end: the **mid-sector** work-order card from M3 is still in the game at wave
17 and still changes nothing. Now that routing has a real home, that card should either
be given a mechanical consequence or removed. Leaving a card that does nothing is the
wave-8-shop mistake wearing different clothes.

### Cross-run persistence — SETTLED 2026-07-26, see "Cross-run persistence changes the deck"

A proposal that "items and levels persist" is ambiguous in a way that matters:

- **Across sectors within a run** — already how items work. No conflict.
- **Across runs** — a direct contradiction of the Progression section above, which
  excludes permanent stat purchases because "they convert a skill problem into a
  grinding problem", and of certifications expanding variety rather than power.

The second reading is a genre change from roguelike to roguelite, and it is a
legitimate one that many good games make. But it cannot be adopted by accident: the
certification system is built under the no-permanent-power constraint and has a test
that structurally forbids a certification from granting a raw stat increase. Adopting
cross-run power means deliberately removing that constraint, not quietly working
around it.

**Settled against the second reading.** The reasoning above is kept because it is the argument the
decision was made on. What it got wrong is the premise that the promise was still pure: the
certified work-order pool has been a hidden simulation input since M4. See **"Cross-run persistence
changes the deck, never the numbers — decided 2026-07-26"** at the end of this document for the
rule, the mechanism it is pinned to, and the six places the code already breaks it.

## Seeded runs

Determinism is architectural (see `docs/ARCHITECTURE.md`), so these come nearly free:

- **Daily contract** — one seed per UTC day, computed offline, identical for everyone.
- **Shared seed** — paste a seed to fly the same run someone else did.
- **Replays** — a run is a seed plus one byte per tick, so a whole run is a few hundred bytes and
  a shareable URL. Enables ghost replays and verifiable daily scores with no backend.
- **Purist mode** — certifications disabled, base pool only. For fair comparison.

## Deliberate non-goals

- **No multiplayer.** Static hosting, and it would consume the whole budget.
- **No accounts or server.** Everything in `localStorage`; the URL is the only sharing channel.
- **Not mobile-*first*.** Keyboard is the primary input and the controls are tuned for it. Mobile
  support is planned (see below and `docs/ROADMAP.md`), but it follows the desktop feel rather
  than compromising it.
- **No procedurally generated art.** Code-defined geometry, hand-tuned. Procedural visuals
  usually read as noise.

## Audio

Everything is synthesised at runtime from declarative layer recipes — no audio files, ever. The
recipe *is* the asset, which is what keeps the "no binary assets" rule honest and makes the
interesting parts (mapping, mixing, limiting) testable in Node.

Tone: cold, mechanical, institutional. Relays, compressors, and load-bearing machinery — not
musical stings. The player's gun is a relay closing, not a laser. A kill is decompression and
venting. Losing the hull is a 900ms power-down.

**The mix hierarchy is a legibility rule, not a taste one**, and it is treated exactly like colour
in `docs/UI.md` rule 3: the important thing must be the loudest thing.

```
alarm 1.00  >  threat 0.95  >  impact 0.62  >  ui 0.60  >  pickup 0.50  >  weapon 0.26
```

Priorities mirror the gains, so the hierarchy decides not just what is quieter but *what gets
dropped* when voices are contested. Both invariants are locked by tests, so changing the hierarchy
requires deliberately changing a test.

**The player fires 20 shots per second**, which is the hardest problem in the audio design: a
full-volume click at 20Hz becomes unbearable within seconds, and pitched blips stack into a drone.
Five mitigations together, because no single one suffices:

1. The weapon is the *quietest* category in the game. It is confirmation that the trigger is held,
   and the player already knows that.
2. 25ms and mostly broadband — filtered clicks fatigue far less than pitched tones.
3. Round-robin pitch and amplitude rotation rather than random draw, specifically because a random
   draw occasionally repeats a value twice in a row, which is the artefact being avoided.
4. A 3-voice cap with a 28ms retrigger gap — headroom for a future fire-rate item, not a throttle
   on the base weapon.
5. Lowest priority in the game, so the gun always loses a contested slot.

Stereo pan is derived from playfield x and capped at ±0.55, so incoming fire is locatable without
hard-panning, which is disorienting on headphones and vanishes on a phone speaker.

**Nobody has heard any of this yet — but it is now measured.** `npm run audio` renders every cue
through the real backend and asserts what a listener would notice: no clipping, the hierarchy above
holding in LUFS rather than in constants, cues that mean different things staying distinguishable,
and the hazard warning standing clear of combat noise. It also writes WAVs for whoever listens
first. It found that enemy fire was 3 dB *quieter* than the player's own gun, that ten of twenty
sounds were pinned to the same gain by a clamp, and that four cues were inaudible on a laptop
speaker. See `docs/VERIFICATION.md` §5 for what it still cannot tell you — chiefly whether any of
it is any good.

## Mobile support — the decision, made early

Planned, not a non-goal. The architecture already handles the hard part, and one constraint is
settled now so it doesn't get relitigated later.

**Input is free.** The simulation only ever sees an `InputSnapshot` and never reads the keyboard,
so touch is purely an input-layer concern: no sim changes, no risk to determinism, and a replay
recorded on a phone stays valid on a desktop. The scheme is **relative drag** (the ship moves by
the drag delta, so a thumb never covers the ship), **auto-fire always on** (a fire button is pure
tax in a shmup), and focus as a second thumb zone.

**THE FROZEN CONSTRAINT: the playfield's aspect ratio and virtual units never change.** 448×720,
on every device, forever. Only the *panel's placement* is responsive — a right-hand column in
landscape, a bottom bar in portrait.

**Why this is not negotiable:** a wider playfield makes dodging easier and a narrower one makes it
harder. If the play area flexed per device, seeded runs, daily contracts, and shared replays would
stop being comparable, and the entire competitive feature set would quietly become meaningless.
Letterboxing costs screen area; a flexible playfield costs fairness.

Portrait works well under that constraint: on a 390×844 phone the playfield scales to 390×627 with
a ~104px panel bar beneath it, using 731 of 844 available pixels.

**Known traps, recorded now because they're cheaper to know than to debug:**

- iOS will not play WebAudio until a user gesture has occurred. Audio synthesis initialised at
  page load is silently muted on iPhone. Relevant to M2.
- `overscroll-behavior: none` is needed or pull-to-refresh fires mid-run.
- Safe-area insets matter on notched devices.
- Additive glow at 3× DPR on a mid-range phone is a real performance risk. The frame-time budget
  in `docs/VERIFICATION.md` is the instrument that will catch it.
- `src/render/panel.ts` derives its content origin from `PLAYFIELD_W`. That is the one hardcoded
  assumption that the panel is a right-hand column, and the thing to break when the panel is next
  worked on.

## Cross-run persistence changes the deck, never the numbers — decided 2026-07-26

**Decision, in one sentence: what persists between runs may only change *which content ids a run
can draw from*, and no persisted value may ever change what a resolved number evaluates to.**

Certifications are the whole mechanism and they stay the whole mechanism. There is no permanent
stat purchase, no surviving level or XP total, no bank balance, no per-hull mastery track, and no
starting-item carry-over. This settles the UNRESOLVED entry under "Proposals not yet decided"
against the roguelite reading, and it is deliberate rather than conservative: the code was already
built to this rule in the one place it is expressible, and the replay corpus is already sitting on
this exact line.

Line numbers below were taken on 2026-07-26 and the tree is being edited; the symbol names are the
durable part.

### Where the line is, pinned to a mechanism

Four tests. A proposal has to pass all four, and a future author should be able to apply them
without reopening this argument.

1. **The unit of persistence is an id entering a named pool.** `PoolGrant` is `{ slice, id }`
   (`src/content/certifications.ts:110`) and there is nowhere in it to write a magnitude. If a
   proposal needs a *number* in the persisted payload — a level, a rank, a currency, a multiplier,
   a count of anything the run consumes — it is on the wrong side. The one persisted number is
   `CertificationState.progress`, and it is write-only with respect to the simulation: only the
   hangar reads it, through `describeProgress` (`src/meta/certifications.ts:323`).
2. **A pool may only grow, and only into a table the run already draws from a fixed number of
   times.** `poolFor` puts the base pool first and in full, so it has no way to *narrow* a run
   (`src/meta/certifications.ts:491`). The number of draws is fixed by `ITEM_CHOICE_WAVES = [7,
   20]`, `SHOP_WAVES = [13, 24]` and `WORK_ORDER_WAVES = [17]` (`src/sim/progression.ts:46-61`),
   which are content constants and not persisted state. **A certification may change what is
   offered; never how many offers exist, and never what a taken offer does.**
3. **The falsifiable question.** For a fixed seed, could this persisted value change the output of
   `resolveStat` (`src/sim/stats.ts:97`), a `shopCosts` / `transitShopCosts` price, a wave script,
   an HP or damage figure, a threshold, a tick count, or the number of stages in the run? If yes,
   it is banned. Could it change only *which id* comes out of a table that is drawn from a fixed
   number of times? Then it is allowed, subject to 4.
4. **Anything allowed under 1–3 is a run input, and a run input must be recorded with the run.**
   The pool is the fourth input to the simulation, after the seed, the hull and the input log. This
   is the clause the code currently fails; see below.

Allowed, therefore: item ids, enemy ids, hull ids, work-order kinds, boss-variant ids and hazard
ids entering their slice. Banned, and today unrepresentable: a permanent stat upgrade; a level or
XP total that survives death; scrap that survives the run (`RunSummary.scrapHeld` is a *balance*
and an unlock condition, never a bank — `src/meta/certifications.ts:71`); a persisted best that can
be spent; an unlocked starting item; an extra offer slot; an unlocked sector or a longer run.

The grey cases, decided now so they are not relitigated:

- **Writing and cosmetics may cross runs freely.** Personnel files already do and touch no
  simulation value (`src/meta/personnel.ts`). Out of scope, not a loophole.
- **An unlocked *starting* item is banned even though Probate has one.** The distinction is the
  owner of the fact: Probate's relic is a property of a hull, identical for everyone who flies
  Probate, fixed in content. A save-level starting item changes the resolved stat vector at tick 0
  with no offer in between, which is test 3 failing.
- **Unlocking difficulty upward is allowed** — enemies, hazards and boss variants are pool draws,
  and `src/content/certifications.ts` is right that they push the opposite way from power. But it
  is not free: a certified pilot's daily is *harder* than a base pilot's, which is exactly why
  test 4 exists.
- **Within-run levels remain open.** The "Experience and levels" proposal above survives this
  decision unchanged, on one condition: a level may not outlive the run, and "unlock a higher level
  cap" is a number and therefore banned.

### How it survives determinism, dailies and the corpus

**Contract 1 as CLAUDE.md states it is already false in the shipped build, and this decision does
not break it — it makes it precise and puts the code on the hook for the difference.** Stating that
plainly matters more than defending the slogan:

- `main.ts:614` passes `workOrders: runPool.workOrders` into `new World(...)`, where `runPool =
  poolFor(unlockedSet(save.certifications.unlocked))` (`main.ts:452`, `:567`). A value read out of
  `localStorage` is a constructor argument to the simulation.
- The sim builds the work-order card from `this.content.workOrders ?? BASE_WORK_ORDERS`
  (`src/sim/world.ts:885`) and takes the card's option count from `choice.workOrders.length`
  (`:918`), which is what `updateCursor` clamps the highlight against.
- `hashWorld` hashes `choice.workOrders.length` and every kind string
  (`src/meta/snapshot.ts:468-469`) and `choiceSelection` (`:502`).
- Therefore **two pilots with the same seed, the same hull and the same input log produce different
  state digests if one holds `vault-clearance` and the other does not.** Not a theory: the
  work-order pool has been wired since M4 fixed the literal in `World`.
- The hull offer is drawn from the persisted pool too — `offerHulls(Rng.fromSeed(seed,
  HULL_OFFER_STREAM), runPool.hulls)` (`main.ts:571`) — and the chosen hull goes into the sim.

So the honest promise is **seed + hull + pool + one byte per tick**. Three of those four are
recorded. The pool is not, and that is the single change this decision requires.

**Where the pool has to be recorded.** In the `src/meta/replay.ts` wire format, as a new field
after `hullId`, and it must be **the granting id set, not the fingerprint** — a fingerprint
verifies, it cannot reconstruct. The cheap form is a bitmask over `CERTIFICATION_IDS`
(`src/meta/certifications.ts:366`), one or two bytes for a ten-entry roster, which makes roster
*order* a format concern in the way `poolFor`'s own header already warns about. That is a
`REPLAY_FORMAT_VERSION` 3 → 4 bump and **not** a `SIM_VERSION` bump, by exactly the argument that
file already makes for `hullId`: the rules did not change, the payload was incomplete. Format-3
replays then fail loudly at the version check instead of being flown against the viewer's pool.
`playback` must then build the world from `poolFor(unlockedSet(replay.certifications))` and
**throw if the world reports a different pool fingerprint**, which is the guard `hullId` was given
after M5 found that a field can exist and still be decoration.

**The corpus survives untouched, and this is the strongest practical argument for the line.** Every
recorded fixture was produced through a `RunContent` with `workOrders` omitted
(`tools/playtest.ts:75`, `tests/bots.test.ts`), i.e. against `BASE_WORK_ORDERS`. A new pool field
that defaults to "nothing certified" reproduces all of it bit-exactly. No re-base, no
`SIM_VERSION` bump, no `DIGEST_GENERATION` bump. The base pool is already where the corpus lives.

**Daily contracts.** `src/meta/seedModes.ts:611` already decides this correctly and says why — the
daily is `purist: true` because "if certifications could change its item pool, two players flying
'the same' contract would be flying different runs, and the one thing the daily is for is
comparability". That rule is right and it is **not implemented**. A daily is therefore flown from
`poolFor(new Set())`, hull offer included, and that is a fix rather than a design change.

**Shared seeds** are comparable only within an identical pool, which `verifyPurist` already reports
as `purist` versus `expanded`. Nothing changes there except that the label has to become true.

### What it means for purist mode

Purist mode stops being a badge and becomes **the definition of the comparable game**.

1. `poolFor(new Set())` has to be *the run*, not just the fingerprint filed afterwards.
   `RunMode.purist` must gate `runPool` at `main.ts:452` and `:567`, and must gate the hull offer —
   `BASE_POOL.hulls` is `['lien']`, so a purist run offers one hull and `shouldShowHullSelect`
   correctly skips the card.
2. Purist is not "the fair mode versus the cheat mode". It is the base pool, which is **the only
   difficulty band anyone has ever measured**: every M5 exit number — 26.5% / 36.5% clear, the hull
   spread, the death shares — came from a harness that omits `workOrders`. The certified game is
   unmeasured, and this decision turns that from an unknown into a scheduled sweep.
3. Purist stays *derived, never stored* (`src/meta/purist.ts` header). This decision adds nothing
   falsifiable: the pool is evidence and the verdict belongs to the verifier.

### What this forecloses — the honest cost

1. **The 26–36% clear rate does not get the standard cure.** Roguelikes overwhelmingly answer a
   punishing clear rate with meta-progression, and this decision refuses that answer permanently.
   What is left is variety, legibility, onboarding, and a fast restart — never a stronger pilot. If
   the game later reads as too punishing, the permitted fixes are content and tuning.
2. **Daily contracts are comparable only among purist runs**, so a certified player who wants to
   compete on the contract flies a pool they did not choose. Accepted: comparing across pools is
   not comparison.
3. **Certifications will always be a weaker retention hook than a power curve**, because their
   reward is "more varied, slightly harder" and that is a *worse* reward to a player who wants to
   feel stronger. The Progression section accepted this already; this section means it cannot be
   quietly revisited by adding one word to `POOL_SLICES`.
4. **Every future pool slice becomes a versioned change, not a content change.** Gating `items` or
   `enemies` on the pool moves every existing player's fingerprint, so stored records stop matching
   the verifier's base pool.

### Two things it fixes for free

- **`fingerprintPool` gets a job it can finish.** The fingerprint is filed in every personnel
  record (`main.ts:526`) and compared against the verifier's base pool, but nothing can *reproduce*
  from it, because the pool is not in the replay. Recording the granting id set makes purist tier 2
  executable rather than merely described.
- **Contract 1 becomes true as written.** "Same seed and inputs" becomes "same seed, hull, pool and
  inputs", with all four recorded fields. A contract that is precisely true is enforceable by a
  test; one that is approximately true gets worked around, which is how the work-order pool became
  a hidden simulation input without anyone deciding it should be.
