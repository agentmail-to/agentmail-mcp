#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { AgentMailToolkit } from 'agentmail-toolkit/mcp'

async function main() {
    const server = new McpServer({ name: 'AgentMail', version: '0.1.0' })
    const transport = new StdioServerTransport()

    for (const tool of new AgentMailToolkit().getTools()) {
        server.tool(tool.name, tool.description, tool.paramsSchema, tool.callback)
    }

    await server.connect(transport)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
