/**
 * Work-order assignments.
 *
 * Content, not UI. This table was first written inside `src/ui/choiceScreen.ts`
 * because no content module existed for it, which is the wrong home: a work order
 * is authored data like an enemy or an item, and a screen that owns its own content
 * cannot be re-skinned or re-balanced independently.
 *
 * See WorkOrderKind in ./types.ts for why these currently sit inside a sector
 * rather than between sectors.
 */

import type { WorkOrderDef, WorkOrderKind } from './types'

export const WORK_ORDERS: Readonly<Record<WorkOrderKind, WorkOrderDef>> = {
  supply: {
    kind: 'supply',
    name: 'Supply Corridor',
    description: 'A charted lane. Lighter opposition, and salvage is already crated for recovery.',
  },
  hazard: {
    kind: 'hazard',
    name: 'Hazard Corridor',
    description: 'Heavier opposition the whole way through, paid at the elevated recovery rate.',
  },
  vault: {
    kind: 'vault',
    name: 'Vault Approach',
    description: 'One sealed cache under guard. Everything else in the lane is someone else’s job.',
  },
  repair: {
    kind: 'repair',
    name: 'Repair Detour',
    description: 'A yard stop. Hull integrity is restored, and the corridor pays nothing for it.',
  },
  unlisted: {
    kind: 'unlisted',
    name: 'Unlisted Assignment',
    description: 'Not on the manifest. Requisition declines to describe the opposition.',
  },
}

export function getWorkOrder(kind: string): WorkOrderDef | undefined {
  return Object.hasOwn(WORK_ORDERS, kind) ? WORK_ORDERS[kind as WorkOrderKind] : undefined
}
