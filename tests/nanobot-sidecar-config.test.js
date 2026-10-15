import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Phase 3.2: sidecar config exposes only the approved MCP tools', async () => {
  const config = JSON.parse(
    await readFile(new URL('../config/nanobot-sidecar.example.json', import.meta.url), 'utf8')
  );
  const server = config?.tools?.mcpServers?.gosu_library;
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, ['src/nanobot/mcp-server.js']);
  assert.deepEqual(server.enabledTools, ['search_library', 'get_admin_brief']);
  assert.equal(server.toolTimeout, 30);
  assert.equal(server.env.NANOBOT_MCP_TOKEN, '${NANOBOT_MCP_TOKEN}');
  assert.equal(server.env.NANOBOT_MCP_SESSION_TOKEN, '${NANOBOT_MCP_SESSION_TOKEN}');
});

test('Phase 3.2: sidecar config cannot enable arbitrary repository tools', async () => {
  const config = JSON.parse(
    await readFile(new URL('../config/nanobot-sidecar.example.json', import.meta.url), 'utf8')
  );
  const names = config.tools.mcpServers.gosu_library.enabledTools;
  assert.equal(names.length, 2);
  assert.ok(names.every(name => ['search_library', 'get_admin_brief'].includes(name)));
});
