import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const requireFromServer = createRequire(
  new URL('../packages/server/package.json', import.meta.url),
)
const { z } = requireFromServer('zod')
const toolkitPackage = JSON.parse(
  await readFile(
    new URL(
      '../packages/server/node_modules/agentmail-toolkit/package.json',
      import.meta.url,
    ),
    'utf8',
  ),
)

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_hosted_contract'
process.env.CLERK_SECRET_KEY = 'sk_test_hosted_contract'

const {
  ActionableToolError,
  GENERIC_TOOL_ERROR_MESSAGE,
  INVALID_ORG_SELECTION_MESSAGE,
  MULTI_ORG_SELECTION_REQUIRED_MESSAGE,
  PINNED_ORG_SELECTION_CONFLICT_MESSAGE,
  conflictsWithPinnedOrganization,
  createMcpServer,
  omitHostedInboxMetadataInput,
  publicToolFailure,
  resolveEffectiveSelectedOrganizationId,
  sanitizeHostedToolResult,
} = await import('../packages/server/build/index.js')

async function listHostedTools() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer({ kind: 'apiKey', apiKey: 'contract-only' })
  const client = new Client({ name: 'hosted-contract-test', version: '1.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return (await client.listTools()).tools
  } finally {
    await client.close()
    await server.close()
  }
}

test('hosted catalog exposes exactly 25 tools without auth_me', async () => {
  const tools = await listHostedTools()
  const names = tools.map(({ name }) => name)

  assert.equal(names.length, 25)
  assert.equal(new Set(names).size, 25)
  assert.ok(names.includes('list_organizations'))
  assert.ok(names.includes('select_organization'))
  assert.ok(!names.includes('auth_me'))
})

test('hosted inbox schemas omit metadata from mutations and all inbox outputs', async () => {
  const tools = new Map((await listHostedTools()).map((tool) => [tool.name, tool]))

  for (const name of ['create_inbox', 'update_inbox']) {
    assert.ok(!('metadata' in tools.get(name).inputSchema.properties), `${name} input`)
    assert.doesNotMatch(tools.get(name).description, /metadata/i)
  }

  for (const name of ['get_inbox', 'create_inbox', 'update_inbox']) {
    assert.ok(!('metadata' in tools.get(name).outputSchema.properties), `${name} output`)
  }

  const inboxItemSchema = tools.get('list_inboxes').outputSchema.properties.inboxes.items
  assert.ok(!('metadata' in inboxItemSchema.properties), 'list_inboxes item output')
  assert.equal(inboxItemSchema.additionalProperties, false)
})

test('metadata omission preserves a full Zod object root policy', () => {
  const strictInput = z.strictObject({
    displayName: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  const adapted = omitHostedInboxMetadataInput(strictInput)

  assert.notEqual(adapted, strictInput)
  assert.ok(!('metadata' in adapted.shape))
  assert.equal(adapted.safeParse({ displayName: 'Support' }).success, true)
  assert.equal(
    adapted.safeParse({ displayName: 'Support', unexpected: true }).success,
    false,
    'strict root behavior must survive ZodObject.omit',
  )
  assert.equal(
    adapted.safeParse({ displayName: 'Support', metadata: { private: 'value' } })
      .success,
    false,
    'omitted metadata must be rejected by a strict root',
  )

  const rawShape = {
    displayName: z.string().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  }
  const adaptedRawShape = omitHostedInboxMetadataInput(rawShape)
  assert.ok(!('metadata' in adaptedRawShape))
  assert.equal(adaptedRawShape.displayName, rawShape.displayName)
})

test('effective organization selection follows request routing precedence', () => {
  assert.equal(
    resolveEffectiveSelectedOrganizationId(
      'org_oauth',
      ['org_oauth', 'org_stored'],
      'org_stored',
    ),
    'org_oauth',
  )
  assert.equal(
    resolveEffectiveSelectedOrganizationId(undefined, ['org_only'], 'org_stale'),
    'org_only',
  )
  assert.equal(
    resolveEffectiveSelectedOrganizationId(
      undefined,
      ['org_first', 'org_stored'],
      'org_stored',
    ),
    'org_stored',
  )
  assert.equal(
    resolveEffectiveSelectedOrganizationId(
      undefined,
      ['org_first', 'org_second'],
      undefined,
    ),
    undefined,
  )
})

test('pinned organization selection only permits a truthful no-op', () => {
  assert.equal(
    conflictsWithPinnedOrganization('org_oauth', 'org_oauth'),
    false,
  )
  assert.equal(
    conflictsWithPinnedOrganization('org_oauth', 'org_different'),
    true,
  )
  assert.equal(
    conflictsWithPinnedOrganization(undefined, 'org_different'),
    false,
  )
  assert.doesNotMatch(
    PINNED_ORG_SELECTION_CONFLICT_MESSAGE,
    /org_oauth|org_different|Secret Org|requested/i,
  )
  assert.match(PINNED_ORG_SELECTION_CONFLICT_MESSAGE, /Reconnect/)
})

test('hosted inbox results strip metadata from structured content and text', () => {
  const inbox = {
    podId: 'pod_1',
    inboxId: 'inbox_1',
    email: 'test@example.com',
    metadata: { private: 'never expose' },
    updatedAt: '2026-07-24T00:00:00Z',
    createdAt: '2026-07-24T00:00:00Z',
  }

  for (const name of ['get_inbox', 'create_inbox', 'update_inbox']) {
    const result = sanitizeHostedToolResult(name, {
      structuredContent: inbox,
      content: [{ type: 'text', text: JSON.stringify(inbox) }],
      isError: false,
    })
    assert.ok(!('metadata' in result.structuredContent), `${name} structured content`)
    assert.ok(!('metadata' in JSON.parse(result.content[0].text)), `${name} text content`)
  }

  const listResult = sanitizeHostedToolResult('list_inboxes', {
    structuredContent: { count: 1, inboxes: [inbox] },
    content: [{ type: 'text', text: JSON.stringify({ count: 1, inboxes: [inbox] }) }],
    isError: false,
  })
  assert.ok(!('metadata' in listResult.structuredContent.inboxes[0]))
  assert.ok(!('metadata' in JSON.parse(listResult.content[0].text).inboxes[0]))
})

test('public failures are stable and actionable while logs retain diagnostics', () => {
  const logged = []
  const originalConsoleError = console.error
  console.error = (...args) => logged.push(args)
  try {
    const unexpected = new Error(
      'Clerk failed for user_123 in org_private named Highly Confidential',
    )
    const unexpectedResult = publicToolFailure('tool list_inboxes', unexpected)
    assert.equal(unexpectedResult.content[0].text, GENERIC_TOOL_ERROR_MESSAGE)
    assert.equal(unexpectedResult.isError, true)
    assert.equal(logged[0][1], unexpected)

    const actionable = new ActionableToolError(
      MULTI_ORG_SELECTION_REQUIRED_MESSAGE,
      'user_123 belongs to Secret Org (org_private)',
    )
    const actionableResult = publicToolFailure('tool list_inboxes', actionable)
    assert.equal(
      actionableResult.content[0].text,
      MULTI_ORG_SELECTION_REQUIRED_MESSAGE,
    )
    assert.equal(logged[1][1], actionable)
    assert.equal(
      actionable.diagnosticMessage,
      'user_123 belongs to Secret Org (org_private)',
    )
  } finally {
    console.error = originalConsoleError
  }

  for (const message of [
    MULTI_ORG_SELECTION_REQUIRED_MESSAGE,
    INVALID_ORG_SELECTION_MESSAGE,
  ]) {
    assert.doesNotMatch(message, /user_123|org_private|Highly Confidential|Secret Org/)
    assert.match(message, /list_organizations/)
    assert.match(message, /select_organization/)
  }
})

function propertyPaths(schema, path = []) {
  if (!schema || typeof schema !== 'object') return []
  const paths = []
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties)) {
      const childPath = [...path, name]
      paths.push(childPath, ...propertyPaths(child, childPath))
    }
  }
  if (schema.items) paths.push(...propertyPaths(schema.items, [...path, '[]']))
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (!Array.isArray(schema[keyword])) continue
    for (const variant of schema[keyword]) {
      paths.push(...propertyPaths(variant, path))
    }
  }
  return paths
}

function unionNodes(schema, path = []) {
  if (!schema || typeof schema !== 'object') return []
  const nodes = []
  for (const keyword of ['anyOf', 'oneOf']) {
    if (Array.isArray(schema[keyword])) {
      nodes.push({ path, variants: schema[keyword] })
    }
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [name, child] of Object.entries(schema.properties)) {
      nodes.push(...unionNodes(child, [...path, name]))
    }
  }
  if (schema.items) nodes.push(...unionNodes(schema.items, [...path, '[]']))
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (!Array.isArray(schema[keyword])) continue
    for (const variant of schema[keyword]) {
      nodes.push(...unionNodes(variant, path))
    }
  }
  return nodes
}

function structurallyExcludes(schema, property) {
  if (
    schema.additionalProperties === false &&
    !(property in (schema.properties ?? {}))
  ) {
    return true
  }
  return Boolean(schema.not?.required?.includes(property))
}

function toolkitSupportsPost052Contract(version) {
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[.-]/, 3)
    .map((part) => Number.parseInt(part, 10))
  return major > 0 || minor > 5 || (minor === 5 && patch >= 2)
}

test(
  'agentmail-toolkit >=0.5.2 satisfies hosted approval schema invariants',
  {
    skip: toolkitSupportsPost052Contract(toolkitPackage.version)
      ? false
      : `requires agentmail-toolkit >=0.5.2; installed ${toolkitPackage.version}`,
  },
  async () => {
    const tools = new Map((await listHostedTools()).map((tool) => [tool.name, tool]))
    const forbiddenOutputProperties = new Set([
      'podId',
      'clientId',
      'headers',
      'extractionError',
    ])
    const violations = []
    for (const tool of tools.values()) {
      for (const path of propertyPaths(tool.outputSchema)) {
        if (forbiddenOutputProperties.has(path.at(-1))) {
          violations.push(`${tool.name}.${path.join('.')}`)
        }
      }
    }
    assert.deepEqual(violations, [])

    for (const name of [
      'send_message',
      'reply_to_message',
      'forward_message',
      'create_draft',
    ]) {
      const itemSchema = tools.get(name).inputSchema.properties.attachments.items
      const variants = itemSchema.anyOf ?? itemSchema.oneOf
      assert.ok(Array.isArray(variants), `${name} attachment union`)
      const contentBranch = variants.find((variant) =>
        variant.required?.includes('content'),
      )
      const urlBranch = variants.find((variant) =>
        variant.required?.includes('url'),
      )
      assert.ok(contentBranch, `${name} content attachment branch`)
      assert.ok(urlBranch, `${name} URL attachment branch`)
      assert.ok(
        structurallyExcludes(contentBranch, 'url'),
        `${name} content branch must exclude URL`,
      )
      assert.ok(
        structurallyExcludes(urlBranch, 'content'),
        `${name} URL branch must exclude content`,
      )
    }

    const replyModeUnion = unionNodes(
      tools.get('reply_to_message').inputSchema,
    ).find(({ path, variants }) => {
      if (path.includes('attachments') || path.length === 0) return false
      const serialized = JSON.stringify(variants)
      return /replyAll|recipient|sender/i.test(serialized)
    })
    assert.ok(replyModeUnion, 'reply recipient modes must be a nested union')
    assert.ok(replyModeUnion.variants.length >= 2)
  },
)
