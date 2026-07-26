/**
 * The assembled run: sectors paired with the bosses that guard them.
 *
 * This file exists because `sectors.ts` deliberately refuses to name a boss id. Its
 * authors' reasoning is worth keeping: a stage naming `'repossessor'` in a file that
 * cannot import the boss table is an unverifiable cross-file promise, and the failure
 * mode is a run that dies at a stage boundary with nothing to point at.
 *
 * So the pairing is made HERE, where both tables are in scope and a typo is a
 * `getBoss` throw at module load rather than a missing fight ninety seconds in.
 */

import { BOSSES, BOSS_ORDER } from './bosses'
import { HAZARDS } from './hazards'
import { RUN_STAGES } from './sectors'
import type { RunDef, RunStageDef } from './types'

/**
 * Sector order and boss order are asserted to line up, index for index.
 *
 * `BOSS_ORDER`'s own docstring states that its index is also the index into
 * `SECTOR_PLAYER_DPS`, which is what makes every time-to-kill in bosses.ts
 * checkable — so a run that paired them any other way would quietly invalidate that
 * whole file's arithmetic.
 */
export const STAGES: readonly RunStageDef[] = RUN_STAGES.map((stage, index) => {
  const bossId = BOSS_ORDER[index]
  if (bossId === undefined) {
    throw new Error(
      `Run stage ${index} ("${stage.sectorId}") has no boss: BOSS_ORDER has ${BOSS_ORDER.length} entries for ${RUN_STAGES.length} stages`,
    )
  }
  if (BOSSES[bossId] === undefined) {
    throw new Error(`Run stage ${index} ("${stage.sectorId}") names unknown boss "${bossId}"`)
  }
  for (const hazardId of stage.hazardIds) {
    if (HAZARDS[hazardId] === undefined) {
      throw new Error(`Run stage ${index} ("${stage.sectorId}") names unknown hazard "${hazardId}"`)
    }
  }
  return { ...stage, bossId }
})

export const STANDARD_RUN: RunDef = {
  id: 'standard',
  name: 'Salvage Contract',
  stages: STAGES,
}
