#!/usr/bin/env node
// Removes prebuild-install and nan from node_modules before electron-builder
// runs, so they and their transitive deps disappear from `npm list --omit dev`
// and the "duplicate dependency references" warning is gone for real.
//
// prebuild-install/nan are only needed during `npm install` to download/build
// the native binary — by packaging time that job is done.
//
// Also patches node-pty-prebuilt-multiarch/package.json so npm doesn't report
// the removed packages as missing.
//
// Re-run by `predist` before every build so it survives `npm install`.
'use strict'
const fs   = require('fs')
const path = require('path')

const ROOT     = path.resolve(__dirname, '..')
const NM       = path.join(ROOT, 'node_modules')
const REMOVE   = ['prebuild-install', 'nan']

function rmrf(dir) {
  if (!fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}

// Remove from node-pty's package.json so npm doesn't flag them as missing
const ptyPkg = path.join(NM, 'node-pty-prebuilt-multiarch/package.json')
if (fs.existsSync(ptyPkg)) {
  const pkg = JSON.parse(fs.readFileSync(ptyPkg, 'utf8'))
  let changed = false
  for (const name of REMOVE) {
    if (pkg.dependencies?.[name])         { delete pkg.dependencies[name];         changed = true }
    if (pkg.optionalDependencies?.[name]) { delete pkg.optionalDependencies[name]; changed = true }
  }
  if (changed) fs.writeFileSync(ptyPkg, JSON.stringify(pkg, null, 2) + '\n')
}

let removed = 0
for (const name of REMOVE) {
  if (rmrf(path.join(NM, name))) removed++
}

if (removed > 0) {
  console.log(`[patch-pty-pkg] removed ${removed} build-only package(s): ${REMOVE.join(', ')}`)
} else {
  console.log('[patch-pty-pkg] already clean, nothing to do')
}
