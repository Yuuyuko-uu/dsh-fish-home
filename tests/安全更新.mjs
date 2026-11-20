import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-home-safe-update-'))
const home = path.join(temp, 'profile', 'fish-home-room')
const stage = path.join(temp, 'release')
const downloads = path.join(temp, 'downloads')
const zip = path.join(downloads, 'fish-home-room-0.1.2.zip')
const badZip = path.join(downloads, 'fish-home-room-invalid.zip')
const updateScript = path.join(home, 'update-fish-home.ps1')

function writeRuntime(root, version) {
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'app-server.js'), `// ${version}`)
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fish-home-room-runtime', version }))
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), version)
}

function zipDirectory(source, destination) {
  const q = value => "'" + value.replaceAll("'", "''") + "'"
  const command = `Compress-Archive -Path (Join-Path ${q(source)} '*') -DestinationPath ${q(destination)} -Force`
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

test('room updater changes only runtime files and keeps a rollback copy', () => {
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(stage, { recursive: true })
    fs.mkdirSync(downloads, { recursive: true })
    writeRuntime(home, '0.1.0')
    writeRuntime(stage, '0.1.2')
    fs.writeFileSync(path.join(home, 'fish-room.json'), 'custom-root-config')
    fs.mkdirSync(path.join(home, 'data'), { recursive: true })
    fs.writeFileSync(path.join(home, 'data', 'life.sqlite'), 'saved-game')
    fs.writeFileSync(path.join(home, 'data', 'life.sqlite-wal'), 'old-wal')
    fs.writeFileSync(path.join(home, 'data', 'life.sqlite-shm'), 'old-shm')
    const externalSave=path.join(path.dirname(home),'fish-home-data');
    fs.mkdirSync(externalSave);
    fs.writeFileSync(path.join(externalSave,'life.sqlite'),'external-save');
    for (const name of ['update-fish-home.cmd', 'update-fish-home.ps1']) {
      fs.copyFileSync(path.join(repo, 'tools', 'windows', name), path.join(home, name))
      fs.copyFileSync(path.join(repo, 'tools', 'windows', name), path.join(stage, name))
    }
    zipDirectory(stage, zip)

    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updateScript, zip], { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.equal(fs.readFileSync(path.join(home, 'app-server.js'), 'utf8'), '// 0.1.2')
    assert.equal(fs.readFileSync(path.join(home, 'dist', 'index.html'), 'utf8'), '0.1.2')
    assert.equal(fs.readFileSync(path.join(home, 'data', 'life.sqlite'), 'utf8'), 'saved-game')
    assert.equal(fs.readFileSync(path.join(home, 'data', 'life.sqlite-wal'), 'utf8'), 'old-wal')
    assert.equal(fs.readFileSync(path.join(home, 'data', 'life.sqlite-shm'), 'utf8'), 'old-shm')
    assert.equal(fs.readFileSync(path.join(externalSave,'life.sqlite'),'utf8'),'external-save');
    assert.equal(fs.readFileSync(path.join(home, 'fish-room.json'), 'utf8'), 'custom-root-config')
    const backups = fs.readdirSync(path.join(path.dirname(home), 'fish-home-room-backups'))
    assert.equal(backups.length, 1)
    assert.equal(fs.readFileSync(path.join(path.dirname(home), 'fish-home-room-backups', backups[0], 'dist', 'index.html'), 'utf8'), '0.1.0')

    const invalid = path.join(temp, 'invalid')
    fs.mkdirSync(invalid, { recursive: true })
    fs.writeFileSync(path.join(invalid, 'app-server.js'), '// invalid')
    fs.mkdirSync(downloads, { recursive: true })
    zipDirectory(invalid, badZip)
    const rejected = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', updateScript, badZip], { encoding: 'utf8', timeout: 30000 })
    assert.equal(rejected.status, 1)
    assert.equal(fs.readFileSync(path.join(home, 'app-server.js'), 'utf8'), '// 0.1.2')
    assert.equal(fs.readFileSync(path.join(home, 'data', 'life.sqlite'), 'utf8'), 'saved-game')
  } finally {
    const resolved=fs.realpathSync(temp);
    if(path.dirname(resolved)===fs.realpathSync(os.tmpdir())&&path.basename(resolved).startsWith('fish-home-safe-update-')){
      fs.rmSync(resolved, { recursive: true, force: true })
    }
  }
})
