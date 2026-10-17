#!/usr/bin/env node
/**
 * Regression guard for the DSH version policy (see AGENTS.md §1):
 *
 *   Every `@deepseek-ai/dsh*` peer must declare a FLOOR ONLY (`>=x.y.z[-pre]`),
 *   so the plugin stays installable on the declared floor and every later
 *   harness — today 0.1.7-0, 0.2.0-rc.1, 0.2.0-rc.2, 0.2.1-rc.1, and any
 *   future 0.3.x / 1.x.
 *
 * Three rules are enforced here, both from AGENTS.md §1:
 *
 *  1. No ceiling, ever. `^0.1.7-0` means `>=0.1.7-0 <0.2.0`, and the harness
 *     rejects the whole bundle with `incompatible-version` the moment it moves
 *     past that upper bound (observed: dsh 0.2.0-rc.2 refused
 *     dsh-session-bridge@0.4.0 at install time and rolled the install back).
 *     The range looks harmless in review, so the rule needs a machine.
 *  2. `package.json` `engines.dsh` is the AUTHORITATIVE declaration on dsh
 *     0.2.1-rc.1 and later: when it is present the gate evaluates it ALONE and
 *     ignores every peer. It must therefore exist, be floor-only, and state
 *     exactly the peer floor — a narrower `engines.dsh` silently overrides
 *     correct peers, and a wider one silently widens the claim.
 *  3. When a breaking upstream change forces raising the floor, ALL declarations
 *     move together: the 8 peers, `engines.dsh`, and the build-time dev ranges.
 *     Raising only some of them leaves the package claiming compatibility it no
 *     longer has.
 *
 * Runs in `pnpm test`, which both CI and the publish workflow run, so a
 * regression fails the pipeline before it can be published.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), 'utf8'))

/** The one accepted shape: a plain lower bound, prerelease allowed. */
const FLOOR_ONLY = /^>=\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

/** The `engines.dsh` rule, as a predicate, so the guard can self-test it. */
const enginesIsFloor = (manifestLike) => (
  typeof manifestLike.engines?.dsh === 'string' && FLOOR_ONLY.test(manifestLike.engines.dsh)
)

// Self-test the predicates first: a guard that accepts everything guards nothing.
for (const ok of ['>=0.1.7-0', '>=0.2.0-rc.1', '>=1.0.0']) {
  assert.ok(FLOOR_ONLY.test(ok), `predicate must accept the floor-only range ${ok}`)
}
for (const bad of ['^0.1.7-0', '~0.1.7-0', '0.1.7-0', '>=0.1.7-0 <0.3.0', '0.1.7-0 || 0.2.0-rc.2', 'workspace:*', '*', '>=0.1.7-0 <=0.2.0']) {
  assert.ok(!FLOOR_ONLY.test(bad), `predicate must reject the bounded/pinned range ${bad}`)
}
// A missing `engines.dsh` must fail too — since dsh 0.2.1-rc.1 it decides alone, so
// its absence silently hands the decision back to the peers (the old behaviour),
// which is exactly the drift this guard exists to prevent.
assert.ok(enginesIsFloor({ engines: { dsh: '>=0.1.7-0' } }), 'enginesIsFloor must accept a floor')
assert.ok(!enginesIsFloor({ engines: { node: '>=20' } }), 'enginesIsFloor must reject a missing engines.dsh')
assert.ok(!enginesIsFloor({}), 'enginesIsFloor must reject a manifest without engines')
assert.ok(!enginesIsFloor({ engines: { dsh: '^0.1.7-0' } }), 'enginesIsFloor must reject a bounded engines.dsh')

const manifest = readJson('package.json')

const dshPeers = Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

assert.ok(dshPeers.length > 0, 'package.json must declare @deepseek-ai/dsh* peerDependencies')

const bounded = dshPeers.filter(([, range]) => typeof range !== 'string' || !FLOOR_ONLY.test(range))
assert.deepEqual(
  bounded, [],
  'these DSH peers are not floor-only, so a newer harness will reject the whole bundle as '
  + 'incompatible-version (use ">=x.y.z", never "^"/"~"/an exact version/an upper bound):\n'
  + bounded.map(([name, range]) => `  "${name}": ${JSON.stringify(range)}`).join('\n'),
)

// The AUTHORITATIVE declaration since dsh 0.2.1-rc.1: `evaluatePluginCompatibility`
// reads `engines.dsh` first and, when it is present, ignores `peerDependencies`
// entirely (release note: "第三方插件的版本兼容性优先按 engines.dsh 判断；
// 未声明时沿用原有规则"). It therefore has to exist and state exactly the peer
// floor: a narrower range here overrides correct peers and denies the bundle on a
// harness the peers would have accepted.
const engines = manifest.engines?.dsh
assert.ok(
  enginesIsFloor(manifest),
  `package.json engines.dsh must be a floor-only range (it decides alone on dsh >= 0.2.1-rc.1), `
  + `got ${JSON.stringify(engines)}`,
)

// `dsh.plugin.json` is legacy 0.1.x metadata: no 0.2.x harness reads it (verified
// by grepping both the published CLI and the desktop app for the filename), and
// `dsh.bundle.patch` in package.json is what actually mounts the plugin. It is
// still shipped for old harnesses, so it must never drift from the live floor.
const pluginManifest = readJson('dsh.plugin.json')
const legacyEngines = pluginManifest.engines?.dsh
assert.ok(
  typeof legacyEngines === 'string' && FLOOR_ONLY.test(legacyEngines),
  `dsh.plugin.json engines.dsh must be a floor-only range, got ${JSON.stringify(legacyEngines)}`,
)

// The two manifests are versioned together (publish.yml syncs them to the tag);
// a drift here means a release shipped mismatched identity.
assert.equal(
  pluginManifest.version, manifest.version,
  'dsh.plugin.json version must match package.json version',
)

// Every peer must name the same floor: the compatibility claim is one number.
assert.equal(
  new Set(dshPeers.map(([, range]) => range)).size, 1,
  'every DSH peer must declare the same floor: ' + JSON.stringify(Object.fromEntries(dshPeers)),
)
const peerFloor = dshPeers[0][1]

assert.equal(
  engines, peerFloor,
  'package.json engines.dsh must equal the peer floor (AGENTS.md §1: raise every '
  + `declaration together) — engines.dsh is ${JSON.stringify(engines)}, peers say ${JSON.stringify(peerFloor)}`,
)
assert.equal(
  legacyEngines, peerFloor,
  'dsh.plugin.json engines.dsh must equal the peer floor (legacy metadata must not drift) — '
  + `it says ${JSON.stringify(legacyEngines)}, peers say ${JSON.stringify(peerFloor)}`,
)

/** Numeric prerelease-aware comparison, enough for DSH version shapes. */
function compareVersions(a, b) {
  const [coreA, preA = ''] = a.replace(/^>=\s*/, '').split('-', 2)
  const [coreB, preB = ''] = b.replace(/^>=\s*/, '').split('-', 2)
  const numsA = coreA.split('.').map(Number)
  const numsB = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const delta = (numsA[i] ?? 0) - (numsB[i] ?? 0)
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  if (preA === preB) return 0
  if (preA === '') return 1
  if (preB === '') return -1
  const partsA = preA.split('.')
  const partsB = preB.split('.')
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const x = partsA[i]
    const y = partsB[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const numX = /^\d+$/.test(x)
    const numY = /^\d+$/.test(y)
    if (numX && numY) {
      const delta = Number(x) - Number(y)
      if (delta !== 0) return delta < 0 ? -1 : 1
      continue
    }
    if (numX !== numY) return numX ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

// The build-time dev ranges must be floors too (anything else pins the release
// train in review-hostile ways), and must never sit BELOW the declared floor:
// that would mean building and testing against a version the package claims to
// support while never actually exercising it. AGENTS.md §1 step 3 of the
// raise-the-floor checklist.
const dshDev = Object.entries(manifest.devDependencies ?? {})
  .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
assert.ok(dshDev.length > 0, 'package.json must declare @deepseek-ai/dsh* devDependencies')
for (const [name, range] of dshDev) {
  assert.ok(
    typeof range === 'string' && FLOOR_ONLY.test(range),
    `devDependency "${name}" must be a floor-only range, got ${JSON.stringify(range)}`,
  )
  assert.ok(
    compareVersions(range, peerFloor) >= 0,
    `devDependency "${name}" (${JSON.stringify(range)}) is older than the peer floor `
    + `${JSON.stringify(peerFloor)} — raise the dev ranges with the peers (AGENTS.md §1)`,
  )
}

console.log(
  `peer-floor: OK — ${String(dshPeers.length)} DSH peers, package.json engines.dsh and the legacy `
  + `dsh.plugin.json engines.dsh all declare the same floor (${String(peerFloor)}), every later harness `
  + `is accepted by design; ${String(dshDev.length)} dev ranges are floors at or above it`,
)
