#!/usr/bin/env node
import { AgentMailMcpServer } from 'agentmail-toolkit/mcp'
import { BlaxelMcpServerTransport, logger } from '@blaxel/sdk'

async function main() {
    const server = new AgentMailMcpServer()
    const transport = new BlaxelMcpServerTransport()

    await server.connect(transport)
}

main().catch((error) => {
    logger.error(error)
    process.exit(1)
})
