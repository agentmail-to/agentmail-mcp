import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

// agentmail-toolkit 0.12.0 added AgentMailToolkit.invoke(name, client, args)
// so a hosted server builds the toolkit once and passes each call its own
// client. Keep the constructor to the single module-load instance so every
// tool call stays on that path.
test('the toolkit is constructed once, at module load', async () => {
    const source = await readFile(new URL('../packages/server/src/index.ts', import.meta.url), 'utf8')
    const constructions = source.match(/new AgentMailToolkit\(/g) ?? []
    assert.equal(constructions.length, 1, 'tool calls must go through staticToolkit.invoke()')
    assert.match(source, /staticToolkit\.invoke\(/)
})

