#!/usr/bin/env node
import { AgentMailClient } from 'agentmail'
import { AgentMailToolkit } from 'agentmail-toolkit/mcp'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const parseToolsArg = () => {
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

const main = async () => {
    const baseUrl = process.env.AGENTMAIL_BASE_URL
    const toolNames = parseToolsArg()

    const client = new AgentMailClient({ baseUrl })
    const toolkit = new AgentMailToolkit(client)

    const server = new McpServer({ name: 'AgentMail', version: '0.1.0' })
    const transport = new StdioServerTransport()

    for (const tool of toolkit.getTools(toolNames)) server.registerTool(tool.name, tool, tool.callback)

    await server.connect(transport)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
