/**
 * The tool catalog: names, schemas and dispatch. Filled in by the port of
 * Scribe's `ToolCatalog.swift` (plan Task 7); until then the server
 * advertises no tools and refuses every call the way Scribe refuses an
 * unknown one.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { LibraryReader } from './library-reader';

export const TOOLS: Tool[] = [];

/** One text block carrying the message, flagged as an error the model can read and correct. */
export const errorResult = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export async function callTool(
  _reader: LibraryReader,
  name: string,
  _args: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  return errorResult(`Unknown tool '${name}'.`);
}
