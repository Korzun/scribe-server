/**
 * Exports the MCP conformance fixture (spec §10, "Keeping them honest"):
 * writes the corpus as a Scribe store on disk, drives Scribe's stdio server
 * `scribe-mcp` over it through a real MCP handshake, runs the fixed script of
 * tool calls, and records the tools it lists and the parsed payload of every
 * answer. `app/server/mcp/conformance.test.ts` then seals the same store into
 * a vault library, runs the same script against the remote tools and compares.
 *
 * Needs a Mac with Scribe installed: the bundle carries `scribe-mcp` at a
 * stable path, and `SCRIBE_STORE_ROOT` points it at the corpus instead of the
 * real meetings. Nothing here reads or writes the real library.
 *
 *   npm run conformance:export                     # Scribe.app's scribe-mcp
 *   npm run conformance:export -- --scribe-mcp ~/Code/scribe/.build/release/scribe-mcp
 *   npm run conformance:export -- --out /tmp/conformance   # somewhere other than test/conformance
 *
 * Then run the test: `npx vitest run app/server/mcp/conformance.test.ts`
 * (from app/server), and commit `test/conformance/`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { writeCorpus } from '../app/server/mcp/conformance-corpus';
import {
  runStep,
  sortKeys,
  type Expected,
  type Script,
  type StepResult,
  type ToolCaller,
} from '../app/server/mcp/conformance-support';

const DEFAULT_SCRIBE_MCP = '/Applications/Scribe.app/Contents/MacOS/scribe-mcp';
const DEFAULT_OUT = path.resolve(__dirname, '../test/conformance');

const { values } = parseArgs({
  options: {
    'scribe-mcp': { type: 'string', default: process.env.SCRIBE_MCP ?? DEFAULT_SCRIBE_MCP },
    out: { type: 'string', default: DEFAULT_OUT },
    help: { type: 'boolean', default: false },
  },
});

if (values.help) {
  console.log(
    [
      'Usage: npm run conformance:export -- [--scribe-mcp <path>] [--out <dir>]',
      '',
      `  --scribe-mcp  Scribe's stdio MCP server (default: $SCRIBE_MCP or ${DEFAULT_SCRIBE_MCP})`,
      `  --out         directory holding script.json; store/ and expected.json are written there`,
      `                (default: ${DEFAULT_OUT})`,
    ].join('\n')
  );
  process.exit(0);
}

const scribeMcp = path.resolve(values['scribe-mcp']!);
const out = path.resolve(values.out!);

function fail(message: string): never {
  console.error(`export-mcp-conformance: ${message}`);
  process.exit(1);
}

/** The text block every tool answers with. */
const textOf = (result: CallToolResult): string =>
  result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

async function main(): Promise<void> {
  if (!fs.existsSync(scribeMcp)) {
    fail(`no scribe-mcp at ${scribeMcp}; install Scribe or pass --scribe-mcp`);
  }
  const scriptPath = path.join(out, 'script.json');
  if (!fs.existsSync(scriptPath)) fail(`no script at ${scriptPath}`);
  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf8')) as Script;

  const storeDir = path.join(out, 'store');
  const written = writeCorpus(storeDir);
  console.log(`wrote ${written.length} files to ${storeDir}`);

  const transport = new StdioClientTransport({
    command: scribeMcp,
    args: [],
    env: { ...getDefaultEnvironment(), SCRIBE_STORE_ROOT: storeDir },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`scribe-mcp: ${chunk}`));
  const client = new Client({ name: 'scribe-conformance-export', version: '0.0.0' });
  await client.connect(transport);
  try {
    const server = client.getServerVersion();
    const exportedFrom = server ? `${server.name} ${server.version}` : 'unknown';
    console.log(`connected to ${exportedFrom}`);

    const { tools } = await client.listTools();

    const stdioDoor: ToolCaller = async (name, args) => {
      const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
      return result.isError === true
        ? { error: textOf(result) }
        : { payload: JSON.parse(textOf(result)) as unknown };
    };

    const results: StepResult[] = [];
    for (const [index, step] of script.steps.entries()) {
      results.push(await runStep(stdioDoor, step));
      const last = results[index]!;
      const shape = 'pages' in last ? `${last.pages.length} pages` : Object.keys(last)[0];
      console.log(`${String(index).padStart(3)} ${step.name} → ${shape}`);
    }

    const expected: Expected = { version: 1, exportedFrom, tools, results };
    fs.writeFileSync(
      path.join(out, 'expected.json'),
      `${JSON.stringify(sortKeys(expected), null, 2)}\n`
    );
    console.log(
      `wrote ${path.join(out, 'expected.json')}: ${tools.length} tools, ${results.length} steps`
    );
    console.log('next: (cd app/server && npx vitest run app/server/mcp/conformance.test.ts)');
  } finally {
    await client.close();
  }
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
