#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { AgentMailToolkit } from 'agentmail-toolkit/mcp'

function parseToolsArg(): string[] | undefined {
    const args = process.argv.slice(2)

    const toolsIndex = args.indexOf('--tools')
    if (toolsIndex === -1) return undefined

    const toolsArg = args[toolsIndex + 1]
    if (!toolsArg) {
        console.error('Error: --tools flag requires a comma-separated list of tool names')
        process.exit(1)
    }

    return toolsArg.split(',').map((tool) => tool.trim())
}

async function main() {
    const server = new McpServer({ name: 'AgentMail', version: '0.1.0' })
    const transport = new StdioServerTransport()

    for (const tool of new AgentMailToolkit().getTools(parseToolsArg())) {
        server.tool(tool.name, tool.description, tool.paramsSchema, tool.callback)
    }

    await server.connect(transport)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
