/**
 * What to tell the player when loading the save cost them something.
 *
 * WHY THIS EXISTS. `src/meta/save.ts` has computed a `SaveLoadReport` — `reset`,
 * `personnelSkipped`, `personnelDropped` — for as long as the reporting variant has
 * existed, and NOTHING in `src/` ever showed a single field of it to a player. So a
 * pilot who had flown thirty sorties could open the game to pilot #001, an empty
 * hangar and no personnel files, with no indication anywhere that anything had been
 * lost. They conclude the game is broken, or they do not notice at all. By CLAUDE.md's
 * ordering that is a P0 interface bug, the same severity as a crash — not a nicety.
 *
 * WHY IT IS A PURE MODULE RATHER THAN CODE IN `main.ts`. Exactly the reason
 * `claimSortieMode` was extracted into `meta/seedModes.ts`: `main.ts` has no unit
 * test, so wording and layout reachable only through it cannot be checked at all, and
 * this is a screen a player sees precisely once, on the worst day of their save's
 * life. Everything here is a function of the report; `titleScreen.ts` only paints it.
 *
 * TONE, per docs/UI.md. This is functional text, so it gets no jokes — the same rule
 * the incident report's cause line and the personnel screen's "unreadable records"
 * notice follow. It also never says "corrupt": that word tells a player about the
 * bytes, when what they need is which of their things is gone and which is not. The
 * two severities are worded to be told apart at a glance, because they differ enormously
 * — a reset lost everything, a skipped record lost some history and kept the rest.
 */

import type { PersonnelRecord } from '../meta/personnel'
import type { SaveLoadReport } from '../meta/save'
import { wrapText, type Measure } from '../render/text'

/**
 * How bad it was.
 *
 * `reset` — the stored save could not be used at all and a fresh one was substituted.
 * `partial` — the envelope loaded, but the run history came back short. Unlocks,
 * settings and the pilot number survived, which is the whole reason these are not one
 * message.
 */
export type SaveNoticeSeverity = 'reset' | 'partial'

/**
 * A body line and how loud it should be.
 *
 * The tone is decided here rather than in the drawing code so the hierarchy is a
 * property of the message: what was lost reads at full strength, what survived reads
 * quieter. UI.md rule 7's consequence is that a third grey cannot survive AA on a dark
 * panel, so this is two steps and no more.
 */
export interface SaveNoticeLine {
  readonly text: string
  readonly tone: 'loss' | 'reassurance'
}

export interface SaveNotice {
  readonly severity: SaveNoticeSeverity
  readonly heading: string
  readonly lines: readonly SaveNoticeLine[]
  /** How to make it go away. Kept on the notice so the card is self-explaining. */
  readonly dismiss: string
}

/**
 * The dismissal hint, and it names both keys deliberately.
 *
 * The notice must not read as something standing between the player and a sortie —
 * ENTER works while it is on screen, and saying so costs one line.
 */
const DISMISS = 'ESC dismisses this notice — ENTER still launches a sortie.'

/** `#004`, matching the title screen, the incident report and every personnel file. */
function pilotTag(record: PersonnelRecord): string {
  return `#${String(record.pilotNumber).padStart(3, '0')}`
}

/**
 * A count and the oldest file, never the list.
 *
 * `personnelDropped` carries whole records and a hand-edited save can hand back
 * hundreds of them, so dumping ids would be unreadable and would grow the card without
 * bound. "My first pilot is gone" is the fact a player is actually looking for, and the
 * array is documented oldest-first, so the head of it is that pilot.
 */
function droppedLine(dropped: readonly PersonnelRecord[]): string {
  const oldest = dropped[0]
  if (dropped.length === 1) {
    // "oldest" of one file would be noise.
    const tag = oldest ? ` (pilot ${pilotTag(oldest)})` : ''
    return `1 older file was destroyed under the retention schedule${tag}.`
  }
  const tag = oldest ? ` (oldest pilot ${pilotTag(oldest)})` : ''
  return `${dropped.length} older files were destroyed under the retention schedule${tag}.`
}

/**
 * Turn a load report into something to say, or null when there is nothing to say.
 *
 * NULL IS THE COMMON CASE and it includes a brand-new player: `loadSaveWithReport`
 * reports an empty store as no loss, because putting a scary notice in front of
 * someone whose save simply does not exist yet is the interface inventing a problem.
 */
export function describeSaveLoss(report: SaveLoadReport): SaveNotice | null {
  if (report.reset) {
    return {
      severity: 'reset',
      heading: 'PREVIOUS PROGRESS NOT RECOVERED',
      lines: [
        { text: 'Your saved file could not be read, so a new one was started.', tone: 'loss' },
        {
          text: 'Pilot number, certifications, personnel files and settings are back to new.',
          tone: 'loss',
        },
        {
          text: 'Nothing else is wrong. Flying a sortie writes a fresh file.',
          tone: 'reassurance',
        },
      ],
      dismiss: DISMISS,
    }
  }

  const skipped = report.personnelSkipped
  const dropped = report.personnelDropped
  if (skipped <= 0 && dropped.length === 0) return null

  const lines: SaveNoticeLine[] = []
  if (skipped > 0) {
    // "unreadable" and "left out" match `personnelSkippedText` on the personnel
    // screen, which is where the player goes to look at what is left. Two different
    // words for one event would read as two different events.
    lines.push({
      text:
        skipped === 1
          ? '1 stored record was unreadable and is missing from your personnel files.'
          : `${skipped} stored records were unreadable and are missing from your personnel files.`,
      tone: 'loss',
    })
  }
  if (dropped.length > 0) lines.push({ text: droppedLine(dropped), tone: 'loss' })
  // The severity split is only useful if this line is here: the player has to know
  // that the thing they earned over thirty runs is still theirs.
  lines.push({
    text: 'Certifications, settings and your pilot number are intact.',
    tone: 'reassurance',
  })

  return {
    severity: 'partial',
    heading: 'SOME PERSONNEL FILES WERE LOST',
    lines,
    dismiss: DISMISS,
  }
}

// --- layout ------------------------------------------------------------------
//
// Exported as constants for the same reason the pause menu and world map export
// theirs: a test measures the authored copy against the real box (see
// tests/saveNotice.test.ts), and a test that restates a layout number tests its own
// guess. The card lives in the band between the title's controls line and its footer.

export const SAVE_NOTICE_X = 60
export const SAVE_NOTICE_W = 520
export const SAVE_NOTICE_PAD = 14
export const SAVE_NOTICE_TEXT_W = SAVE_NOTICE_W - SAVE_NOTICE_PAD * 2
export const SAVE_NOTICE_HEADING_SIZE = 12
export const SAVE_NOTICE_BODY_SIZE = 12
export const SAVE_NOTICE_LINE_H = 15
/** Height the heading occupies before the first body line. */
const HEADING_H = 16
/** Air above the body, and above the dismissal hint. */
const GAP = 8

/**
 * The card's bottom edge.
 *
 * 646, clear of the footer at `VIRTUAL_H - 62` = 658 where the pilot number and seed
 * sit. Anchored at the bottom and grown upward, because how much went wrong decides
 * the height — the same bottom-up reasoning the personnel screen's notice band uses.
 */
export const SAVE_NOTICE_BOTTOM = 646
/**
 * The highest the card may reach.
 *
 * The controls line is drawn at `VIRTUAL_H * 0.672` ≈ 484, so anything above ~492
 * collides with it. A test asserts the authored copy stays under
 * `SAVE_NOTICE_BOTTOM - SAVE_NOTICE_TOP_LIMIT`, which is what stops a longer sentence
 * quietly overlapping the one line on this screen that is always needed.
 */
export const SAVE_NOTICE_TOP_LIMIT = 492

export interface SaveNoticeLayout {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly heading: string
  /** Wrapped body lines, in order, each keeping the tone of the sentence it came from. */
  readonly body: readonly SaveNoticeLine[]
  readonly dismiss: readonly string[]
}

/**
 * Wrap the notice and place the card. Pure, and measurement is injected.
 *
 * `Measure` rather than a canvas so the wrapping — and therefore the height, and
 * therefore whether this thing overlaps the controls line — is testable in Node.
 */
export function layoutSaveNotice(notice: SaveNotice, measure: Measure): SaveNoticeLayout {
  const body: SaveNoticeLine[] = []
  for (const line of notice.lines) {
    for (const text of wrapText(line.text, SAVE_NOTICE_TEXT_W, SAVE_NOTICE_BODY_SIZE, measure)) {
      body.push({ text, tone: line.tone })
    }
  }
  const dismiss = wrapText(notice.dismiss, SAVE_NOTICE_TEXT_W, SAVE_NOTICE_BODY_SIZE, measure)

  const h =
    SAVE_NOTICE_PAD * 2 +
    HEADING_H +
    GAP +
    body.length * SAVE_NOTICE_LINE_H +
    GAP +
    dismiss.length * SAVE_NOTICE_LINE_H

  return {
    x: SAVE_NOTICE_X,
    y: SAVE_NOTICE_BOTTOM - h,
    w: SAVE_NOTICE_W,
    h,
    heading: notice.heading,
    body,
    dismiss,
  }
}

/** Where the heading's baseline-top sits inside a laid-out card. */
export function saveNoticeHeadingY(layout: SaveNoticeLayout): number {
  return layout.y + SAVE_NOTICE_PAD
}

/** Where the first body line's top sits inside a laid-out card. */
export function saveNoticeBodyY(layout: SaveNoticeLayout): number {
  return saveNoticeHeadingY(layout) + HEADING_H + GAP
}

/** Where the dismissal hint's first line sits inside a laid-out card. */
export function saveNoticeDismissY(layout: SaveNoticeLayout): number {
  return saveNoticeBodyY(layout) + layout.body.length * SAVE_NOTICE_LINE_H + GAP
}
