import assert from 'node:assert/strict'
import test from 'node:test'

process.env.AGENTMAIL_MCP_NO_LISTEN = '1'
process.env.CLERK_PUBLISHABLE_KEY ||= 'pk_test_contract'
process.env.CLERK_SECRET_KEY ||= 'sk_test_contract'

// The catalog exactly as served, so the tools this server defines or rewrites itself
// (list_organizations, select_organization, get_thread's paging) are held to the same floor
// agentmail-toolkit's docs test sets for its own: a field documented only by its name ("ID of
// inbox", "Subject") tells an agent nothing, and Claude Code cuts descriptions at 2 KB.
const { loadProtocolSnapshot } = await import('../packages/server/build/index.js')
const { tools } = JSON.parse((await loadProtocolSnapshot()).toolsListJson)

const words = (text) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
const FILLER = ['id', 'of', 'the', 'a', 'an', 'for', 'to']
const restatesName = (name, description) => {
    const own = new Set([...words(name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')), ...FILLER])
    return words(description).every((word) => own.has(word))
}

/** Every named property in a schema, descending into arrays and unions. */
function namedProperties(schema, path = '') {
    const found = []
    for (const [name, child] of Object.entries(schema?.properties ?? {})) {
        const childPath = path ? `${path}.${name}` : name
        found.push({ path: childPath, name, description: child.description }, ...namedProperties(child, childPath))
    }
    for (const child of [...(schema?.items ? [schema.items] : []), ...(schema?.anyOf ?? [])]) found.push(...namedProperties(child, path))
    return found
}

for (const tool of tools) {
    test(`${tool.name}: every field is documented beyond its name`, () => {
        const thin = [...namedProperties(tool.inputSchema), ...namedProperties(tool.outputSchema)]
            .filter(({ name, description }) => !description || restatesName(name, description))
            .map(({ path, description }) => `${path}: ${JSON.stringify(description ?? null)}`)
        assert.deepEqual(thin, [])
    })

    test(`${tool.name}: the description says more than the name and fits Claude Code`, () => {
        assert.equal(restatesName(tool.name, tool.description), false, tool.description)
        assert.ok(tool.description.length <= 1800, `${tool.description.length} chars`)
    })
}
