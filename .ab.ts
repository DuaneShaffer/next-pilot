/** A/B the content change against the CURRENT sim: M1 values vs M2 values. */
import { ENEMIES } from './src/content/enemies'
import { SECTOR_ONE } from './src/content/sectors'
import { TICK_HZ } from './src/core/loop'
import { BOT_NAMES, type BotName } from './src/sim/bots'
import { deriveSeed, runOnce, summarise } from './tools/playtest'

const RUNS = Number(process.env['RUNS'] ?? '200')
const BASE = process.env['EXP_SEED'] ?? 'K7F29XQM3RTV'
const WHICH = process.argv[2] ?? 'M2'

function d(id: string) { const x = ENEMIES[id]; if (!x) throw new Error(id); return x }

if (WHICH === 'M1') {
  // Restore every value this milestone changed.
  d('hauler').contactDamage = 14
  d('skiff').weapon.intervalTicks = 90
  d('skiff').weapon.windupTicks = 22
  d('lancer').movementParams.holdYFraction = 0.3
  d('turret').hp = 220
  d('turret').weapon.intervalTicks = 105
  d('turret').weapon.damage = 6
  d('turret').weapon.windupTicks = 28
  d('escort').weapon.windupTicks = 30
  d('turret-heavy').weapon.windupTicks = 28
}

const maxTicks = 240 * TICK_HZ
const obs = { enemyDefsSeen: new Set<string>(), sawFocus: false, sawSpecial: false, sawFire: false, distinctInputBytes: new Set<number>() }
const pct = (s: readonly number[], f: number) => s[Math.min(s.length-1, Math.max(0, Math.ceil(f*s.length)-1))] ?? 0

const buckets = [0,0,0,0,0,0]
for (const w of SECTOR_ONE.waves) { let hp=0; for (const f of w.formations) hp += d(f.enemyId).hp*f.count; buckets[Math.floor(w.atSeconds/30)] = (buckets[Math.floor(w.atSeconds/30)] ?? 0)+hp }
console.log(`${WHICH} content, live sim, ${RUNS} runs/policy, seed ${BASE}   HP buckets ${buckets.join('/')}`)
console.log('policy    clear   p10     p25     med     p75     p90     iqr    wave   kills acc     dmg')
for (const policy of BOT_NAMES as readonly BotName[]) {
  const runs = []
  for (let i = 0; i < RUNS; i++) runs.push(runOnce(policy, deriveSeed(BASE, i), { maxTicks, observations: obs }))
  const s = summarise(policy, runs)
  const secs = runs.map(r=>r.seconds).sort((a,b)=>a-b)
  const p25 = pct(secs,0.25), p75 = pct(secs,0.75)
  console.log([policy.padEnd(10), `${(s.survivalRate*100).toFixed(1)}%`.padStart(6),
    s.seconds.p10.toFixed(1).padStart(8), p25.toFixed(1).padStart(8), s.seconds.median.toFixed(1).padStart(8),
    p75.toFixed(1).padStart(8), s.seconds.p90.toFixed(1).padStart(8), (p75-p25).toFixed(1).padStart(7),
    `${s.wave.median}/${s.wave.max}`.padStart(7), s.kills.median.toFixed(0).padStart(6),
    `${(s.accuracy*100).toFixed(1)}%`.padStart(7), s.damageTaken.median.toFixed(0).padStart(6)].join(''))
  const causes = Object.entries(s.deathsByCause).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,n])=>`${k} ${((n/Math.max(1,s.lost))*100).toFixed(0)}%`).join(', ')
  const [t,m,b] = s.deathThirdsVertical
  const sh = (n:number)=>`${((n/Math.max(1,s.lost))*100).toFixed(0)}%`
  console.log(`            ${causes || '(no deaths)'}`)
  console.log(`            vertical thirds: top ${sh(t)} mid ${sh(m)} bottom ${sh(b)}`)
}
