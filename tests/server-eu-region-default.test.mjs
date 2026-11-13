import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

// Without AGENTMAIL_EU_API_URL, EU organizations use the SDK's own EU environment, so the
// hosts can't drift from what the SDK ships.
process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
delete process.env.AGENTMAIL_EU_API_URL
const { apiEndpointFor } = await import('../packages/server/build/index.js')
const require = createRequire(new URL('../packages/server/package.json', import.meta.url))
const { AgentMailEnvironment } = require('agentmail')

test('the EU region defaults to AgentMailEnvironment.EuProd', () => {
    assert.deepEqual(apiEndpointFor('eu'), AgentMailEnvironment.EuProd)
    assert.deepEqual(apiEndpointFor('eu'), { http: 'https://api.agentmail.eu', websockets: 'wss://ws.agentmail.eu' })
})
