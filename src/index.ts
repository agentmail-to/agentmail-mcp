#!/usr/bin/env node
import { AgentMailMcpServer } from 'agentmail-toolkit/mcp'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

async function main() {
    const server = new AgentMailMcpServer()
    const transport = new StdioServerTransport()

    await server.connect(transport)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
