import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('published artifact is an executable bridge without AgentMail implementation dependencies', async (t) => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(packageJson.version, '1.0.1')
    assert.deepEqual(packageJson.dependencies, { '@modelcontextprotocol/sdk': '1.29.0' })

    const built = await readFile(new URL('../build/index.js', import.meta.url), 'utf8')
    assert.match(built, /^#!\/usr\/bin\/env node/)
    assert.match(built, /https:\/\/mcp\.agentmail\.to\/mcp/)
    assert.match(built, /X-AgentMail-MCP-Bridge/)
    assert.match(built, /node\/1\.0\.1/)
    assert.match(built, /agentmail-mcp-node\/1\.0\.1/)
    assert.doesNotMatch(built, /agentmail-toolkit|from ['"]agentmail['"]|list_inboxes|send_message/)
    assert.ok((await stat(new URL('../build/index.js', import.meta.url))).mode & 0o111)

    const env = { ...process.env }
    delete env.AGENTMAIL_API_KEY
    const launch = spawnSync(process.execPath, ['build/index.js'], {
        cwd: new URL('..', import.meta.url),
        env,
        encoding: 'utf8',
    })
    assert.equal(launch.status, 1)
    assert.equal(launch.stdout, '')
    assert.match(launch.stderr, /AGENTMAIL_API_KEY is required/)

    const temp = await mkdtemp(join(tmpdir(), 'agentmail-mcp-bin-'))
    t.after(() => rm(temp, { recursive: true, force: true }))
    const bin = join(temp, 'agentmail-mcp')
    await symlink(fileURLToPath(new URL('../build/index.js', import.meta.url)), bin)
    const symlinkLaunch = spawnSync(process.execPath, [bin], { env, encoding: 'utf8' })
    assert.equal(symlinkLaunch.status, 1)
    assert.equal(symlinkLaunch.stdout, '')
    assert.match(symlinkLaunch.stderr, /AGENTMAIL_API_KEY is required/)

    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
    })
    const files = JSON.parse(output)[0].files.map((file) => file.path)
    assert.ok(files.includes('build/index.js'))
    assert.ok(!files.some((file) => file.startsWith('src/') || file.startsWith('test/')))
})
