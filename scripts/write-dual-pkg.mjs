#!/usr/bin/env node
// Stamps dist/cjs and dist/esm with a minimal package.json so Node resolves
// each subtree's .js files under the right module system, regardless of the
// package's own top-level "type" field.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dist = process.argv[2] || 'dist'

mkdirSync(join(dist, 'cjs'), { recursive: true })
mkdirSync(join(dist, 'esm'), { recursive: true })
writeFileSync(join(dist, 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n')
writeFileSync(join(dist, 'esm', 'package.json'), JSON.stringify({ type: 'module' }) + '\n')
