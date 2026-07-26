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

**Nobody has heard any of this yet.** See the audio blind spot in `docs/VERIFICATION.md`.

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
