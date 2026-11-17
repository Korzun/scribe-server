# MCP conformance fixture

The remote MCP server in this vault and Scribe's stdio `scribe-mcp` must
expose the same five tools with the same payloads (design spec §10). This
directory holds the fixture that proves it:

```
script.json       a fixed list of tool calls, some marked "follow" to walk pages (source)
store/            the corpus as a Scribe store on disk, written by the exporter
expected.json     the parsed results Scribe's stdio server gave, plus its tools/list
```

The corpus itself is TypeScript, `app/server/mcp/conformance-corpus.ts`. The
exporter, `scripts/export-mcp-conformance.ts`, writes it to `store/`, points
Scribe's own `scribe-mcp` at it (`SCRIBE_STORE_ROOT`, so the real library is
never touched), runs `script.json` through a real MCP handshake and records
every answer in `expected.json`. It needs a Mac with Scribe installed, nothing
else; the bundle carries `scribe-mcp` at a stable path.

To (re)generate it, in this repo on that Mac:

```bash
npm ci
npm run conformance:export                 # Scribe.app's scribe-mcp
# or: npm run conformance:export -- --scribe-mcp <path to a scribe-mcp build>
(cd app/server && npx vitest run mcp/conformance.test.ts)
```

then commit `store/` and `expected.json` together.

`app/server/mcp/conformance.test.ts` encrypts `store/` into a temporary
library, runs `script.json` against the remote tools and compares parsed
payloads. It skips while `store/` and `expected.json` are absent and fails if
only one of them is here. Changing a payload on either side, or the corpus,
means re-running the exporter and committing the result, which is exactly the
friction wanted. `expected.json` names the Scribe server version it came from.

One step is shaped around a spelling difference rather than testing it: a
`meeting_ids` element that is not a string is echoed back in the error, and
Scribe spells an object or array element the way Swift describes a value
(`["id": x]`) where the vault spells it as JSON. The script uses a number
there, which both spell the same way.

Compared after normalisation: cursors (`next_cursor`) are dropped, dates are
compared as instants, meeting ids are compared ignoring case (Scribe emits
uppercase UUIDs, the vault canonical lowercase), and the server's
`instructions` and version are not compared at all.
