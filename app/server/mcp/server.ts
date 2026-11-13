/**
 * Builds the per-request MCP server. The low-level `Server` rather than
 * `McpServer`: the five tools advertise the exact JSON schemas Scribe's stdio
 * server does (`tools.ts`), and read their arguments as leniently as it does,
 * which `registerTool`'s zod validation would get in the way of. Stateless
 * transport means a fresh instance per POST with the reader (and so the key)
 * baked into the handlers' closure.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { APP_VERSION } from '../utils/app-version';
import type { LibraryReader } from './library-reader';
import { callTool, TOOLS } from './tools';

export type McpServerDeps = {
  reader: LibraryReader;
  /** The MCP origin (`resolveMcpBaseUrl`), for the website URL in server info. */
  baseUrl: URL;
};

/**
 * Scribe's own instructions, with the one word changed that has to change:
 * these transcripts live in the vault, not on this Mac. Excluded from the
 * conformance comparison, like the version.
 */
export const INSTRUCTIONS =
  'Scribe records and transcribes meetings on a Mac, with speaker attribution, and keeps the ' +
  'library in this vault. These tools read those transcripts; none of them can change anything.\n\n' +
  'When you do not already know which meeting you want, call search_transcripts first — ' +
  'transcripts are long, and reading them whole to find one line wastes the context you need ' +
  'for the answer.\n\n' +
  'Timestamps are seconds from the start of a recording. Ask for detail="full" when the ' +
  'trustworthiness of a line matters: it tells you how confident the speaker attribution was, ' +
  "whether the speech overlapped someone else's, and whether a speaker's name was typed by a " +
  'person or guessed.\n\n' +
  'To point the user at a line, give them a link: scribe://meeting/<meeting_id>?utterance=<index> ' +
  "opens Scribe's Library at that meeting, scrolled to that line. The index is a search hit's " +
  "utterance_index or a transcript line's index; leave it off to open the meeting alone.";

export function buildMcpServer({ reader, baseUrl }: McpServerDeps): Server {
  const server = new Server(
    { name: 'scribe', title: 'Scribe', version: APP_VERSION, websiteUrl: baseUrl.origin },
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    callTool(reader, request.params.name, request.params.arguments)
  );
  return server;
}
