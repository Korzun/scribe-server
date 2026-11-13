# MCP conformance fixture

The remote MCP server in this vault and Scribe's stdio `scribe-mcp` must
expose the same five tools with the same payloads (design spec §10). This
directory holds the fixture that proves it, exported from the Scribe repo:

```
store/            a Scribe store on disk: Meetings/<UUID>/manifest.json, transcript.json, …, and tags.json
script.json       a fixed list of tool calls, some marked "follow" to walk pages
expected.json     the parsed results the stdio server gave, plus its tools/list
```

To (re)generate it, in the Scribe repo:

```bash
Scripts/export-mcp-conformance.sh
# then copy its output directory here, replacing store/, script.json and expected.json
```

`app/server/mcp/conformance.test.ts` encrypts `store/` into a temporary
library, runs `script.json` against the remote tools and compares parsed
payloads. It skips while these three parts are absent and fails if only some
of them are here. Changing a payload on either side means re-running the
exporter and committing in both repositories, which is exactly the friction
wanted.

Compared after normalisation: cursors (`next_cursor`) are dropped, dates are
compared as instants, meeting ids are compared ignoring case (Scribe emits
uppercase UUIDs, the vault canonical lowercase), and the server's
`instructions` and version are not compared at all.
