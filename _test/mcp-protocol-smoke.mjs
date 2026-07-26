import { Client } from '../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { SSEClientTransport } from '../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/sse.js'
import { StreamableHTTPClientTransport } from '../host/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'

const origin = process.env.OMEETY_MCP_ORIGIN || 'http://127.0.0.1:49171'
const expectedTool = 'omeety_get_page_snapshot'

async function withTimeout(label, operation) {
  let timer
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function check(label, transport) {
  const client = new Client({ name: `omeety-${label}-smoke`, version: '1.0.0' })
  try {
    await withTimeout(`${label} connect`, () => client.connect(transport))
    const result = await withTimeout(`${label} tools/list`, () => client.listTools())
    const names = (result.tools || []).map((tool) => tool.name)
    if (!names.includes(expectedTool)) {
      throw new Error(`${label} missing ${expectedTool}; got ${names.length} tools`)
    }
    console.log(`PASS ${label}: initialize + tools/list (${names.length} tools)`)
  } finally {
    await client.close().catch(() => {})
  }
}

await check('streamable-http', new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)))
await check('legacy-sse', new SSEClientTransport(new URL(`${origin}/sse`)))
