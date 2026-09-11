import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixtureRoot = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(fixtureRoot, '..')
const temporaryRoot = join(fixtureRoot, '.tmp')
const packRoot = join(temporaryRoot, 'pack')
const installedPackageRoot = join(temporaryRoot, 'node_modules', '@rvoh', 'psychic-workers')
const typescript = join(packageRoot, 'node_modules', '.bin', 'tsc')

function run(command, args, cwd = packageRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`)
}

rmSync(temporaryRoot, { force: true, recursive: true })
mkdirSync(packRoot, { recursive: true })

try {
  rmSync(join(packageRoot, 'dist'), { force: true, recursive: true })
  run(typescript, ['-p', join(packageRoot, 'tsconfig.cjs.build.json')])
  run(typescript, ['-p', join(packageRoot, 'tsconfig.esm.build.json')])
  run('npm', [
    'pack',
    '--silent',
    '--ignore-scripts',
    '--cache',
    join(temporaryRoot, 'npm-cache'),
    '--pack-destination',
    packRoot,
  ])

  const tarballs = readdirSync(packRoot).filter(path => path.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, 'expected exactly one packed tarball')

  const unpackRoot = join(temporaryRoot, 'unpacked')
  mkdirSync(unpackRoot, { recursive: true })
  run('tar', ['-xzf', join(packRoot, tarballs[0]), '-C', unpackRoot])

  const packedPackageRoot = join(unpackRoot, 'package')
  mkdirSync(dirname(installedPackageRoot), { recursive: true })
  symlinkSync(packedPackageRoot, installedPackageRoot, 'dir')

  for (const path of [
    'dist/esm/src/package-exports/index.js',
    'dist/esm/src/package-exports/errors.js',
    'dist/esm/src/package-exports/types.js',
    'dist/cjs/src/package-exports/index.js',
    'dist/cjs/src/package-exports/errors.js',
    'dist/cjs/src/package-exports/types.js',
    'dist/types/src/package-exports/index.d.ts',
    'dist/types/src/package-exports/errors.d.ts',
    'dist/types/src/package-exports/types.d.ts',
  ]) {
    assert.ok(existsSync(join(packedPackageRoot, path)), `packed package is missing ${path}`)
  }

  const packedManifest = JSON.parse(readFileSync(join(packedPackageRoot, 'package.json'), 'utf8'))
  assert.equal(packedManifest.version, '2.6.0')

  copyFileSync(join(fixtureRoot, 'src', 'consumer.ts'), join(temporaryRoot, 'consumer.ts'))
  copyFileSync(join(fixtureRoot, 'src', 'runtime-esm.mjs'), join(temporaryRoot, 'runtime-esm.mjs'))
  copyFileSync(join(fixtureRoot, 'src', 'runtime-cjs.cjs'), join(temporaryRoot, 'runtime-cjs.cjs'))

  run(typescript, ['-p', join(fixtureRoot, 'tsconfig.json')])
  run(process.execPath, [join(temporaryRoot, 'runtime-esm.mjs')])
  run(process.execPath, [join(temporaryRoot, 'runtime-cjs.cjs')])
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true })
}
