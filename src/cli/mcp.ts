import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createServer } from '../mcp/server.ts'

// stdout carries the MCP protocol; anything human-readable goes to stderr.
await createServer().connect(new StdioServerTransport())
console.error('mcp: home-services server listening on stdio')
