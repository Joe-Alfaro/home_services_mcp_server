import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function createServer(): McpServer {
  // Tools are registered here as they are built.
  return new McpServer({ name: 'home-services', version: '0.1.0' })
}
