import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const manifest = JSON.parse(
  await readFile(new URL('../mcp-manifest.json', import.meta.url), 'utf8'),
)

const coreTools = [
  'list_inboxes',
  'get_inbox',
  'create_inbox',
  'update_inbox',
  'delete_inbox',
  'list_threads',
  'search_threads',
  'get_thread',
  'update_thread',
  'delete_thread',
  'list_messages',
  'search_messages',
  'get_attachment',
  'send_message',
  'reply_to_message',
  'forward_message',
  'update_message',
  'create_draft',
  'list_drafts',
  'get_draft',
  'update_draft',
  'send_draft',
  'delete_draft',
  // agent_verify is in the hosted catalog on purpose. An agent that signed up
  // through /v0/agent/sign-up authenticates here with the key that call returned,
  // and the API now answers its plan-cap errors with "ask your human for the code
  // and call /v0/agent/verify" — a remedy it cannot perform without this tool. It
  // takes an OTP code and returns { verified }, so the identifier concern that
  // keeps auth_me out does not apply.
  'agent_verify',
  // auth_me is deliberately absent: excluded from the hosted catalog only
  // (organization/pod/API-key identifiers are unnecessary on the OpenAI
  // surface); it remains available in agentmail-toolkit for other consumers.
]
const oauthTools = ['list_organizations', 'select_organization']

test('runtime manifest has the canonical tool contract exactly once', () => {
  const names = manifest.tools.map(({ name }) => name)
  assert.equal(new Set(names).size, names.length)
  assert.deepEqual(
    names.filter((name) => !oauthTools.includes(name)).sort(),
    coreTools.sort(),
  )
  assert.deepEqual(
    manifest.tools.filter(({ oauthOnly }) => oauthOnly).map(({ name }) => name).sort(),
    oauthTools.sort(),
  )
  for (const tool of manifest.tools) {
    assert.equal(tool.inputSchema?.type, 'object', `${tool.name} input schema`)
    assert.ok(tool.description, `${tool.name} description`)
  }
})
