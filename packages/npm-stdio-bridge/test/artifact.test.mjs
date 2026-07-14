import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'

test('published artifact is an executable bridge without AgentMail implementation dependencies', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(packageJson.version, '1.0.0')
    assert.deepEqual(packageJson.dependencies, { '@modelcontextprotocol/sdk': '1.29.0' })

    const built = await readFile(new URL('../build/index.js', import.meta.url), 'utf8')
    assert.match(built, /^#!\/usr\/bin\/env node/)
    assert.match(built, /https:\/\/mcp\.agentmail\.to\/mcp/)
    assert.match(built, /X-AgentMail-MCP-Bridge/)
    assert.match(built, /node\/1\.0\.0/)
    assert.match(built, /agentmail-mcp-node\/1\.0\.0/)
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

    const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
    })
    const files = JSON.parse(output)[0].files.map((file) => file.path)
    assert.ok(files.includes('build/index.js'))
    assert.ok(!files.some((file) => file.startsWith('src/') || file.startsWith('test/')))
})
