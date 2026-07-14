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
  'auth_me',
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
