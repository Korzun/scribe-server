import * as path from 'path';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { blobAad, seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';
import {
  CONFORMANCE_DIR,
  fixtureState,
  HOW_TO_EXPORT,
  normalize,
  normalizeTool,
  readStore,
  type ScriptStep,
  type StepResult,
} from './conformance-support';
import { connectMcpClient, mintTokens, textOf, type McpTestClient } from './test-support';

vi.mock('../logger');

const state = fixtureState();

describe('the conformance fixture', () => {
  it('is either absent or complete', () => {
    if (state.kind === 'partial') {
      throw new Error(`test/conformance is missing ${state.missing.join(', ')}: ${HOW_TO_EXPORT}`);
    }
    expect(['absent', 'present']).toContain(state.kind);
  });

  it.skipIf(state.kind === 'present')(
    `is absent, so conformance is not checked here: ${HOW_TO_EXPORT}`,
    () => {
      expect(state.kind).toBe('absent');
    }
  );
});

/** Runs one script step against the remote door exactly as the exporter ran it against the stdio one. */
async function runStep(mcp: McpTestClient, step: ScriptStep): Promise<StepResult> {
  const call = async (
    args: Record<string, unknown>
  ): Promise<{ payload: unknown } | { error: string }> => {
    const result = (await mcp.call(step.name, args)) as CallToolResult;
    return result.isError === true
      ? { error: textOf(result) }
      : { payload: JSON.parse(textOf(result)) as unknown };
  };
  if (step.follow === undefined) return call(step.arguments ?? {});

  const pages: unknown[] = [];
  let args: Record<string, unknown> = { ...(step.arguments ?? {}) };
  for (let page = 0; page < 50; page++) {
    const result = await call(args);
    if ('error' in result) return result;
    pages.push(result.payload);
    const next = (result.payload as Record<string, unknown>)[step.follow];
    if (next === undefined || next === null) break;
    args = step.follow === 'next_cursor' ? { ...args, cursor: next } : { ...args, offset: next };
  }
  return { pages };
}

describe.skipIf(state.kind !== 'present')(
  "the remote tools agree with Scribe's stdio server",
  () => {
    let h: Harness;
    let owner: Owner;
    let mcp: McpTestClient;
    const fixture = state.kind === 'present' ? state : null;

    beforeAll(async () => {
      h = await createHarness({ publicUrl: 'https://vault.example' });
      const client = new VaultClient(h.app);
      writeSetupCode(h.dataDir, 'test-setup-code');
      owner = await createOwner(client, { setupCode: 'test-setup-code' });

      // The exported store, sealed into the library exactly as a Mac would seal it.
      const store = readStore(path.join(CONFORMANCE_DIR, 'store'));
      for (const meeting of store.meetings) {
        for (const file of meeting.files) {
          const bytes = seal(
            owner.libraryKey,
            file.bytes,
            blobAad(owner.libraryId, meeting.id, file.kind, 1)
          );
          const res = await client.putMeetingBlob({
            token: owner.deviceToken,
            meetingId: meeting.id,
            kind: file.kind,
            bytes,
            ifMatch: null,
          });
          expect(res.status, `${meeting.id}/${file.kind}`).toBe(201);
        }
      }
      if (store.tagList !== null) {
        const bytes = seal(
          owner.libraryKey,
          store.tagList,
          blobAad(owner.libraryId, 'library', 'tag-list', 1)
        );
        const res = await client.putLibraryBlob({
          token: owner.deviceToken,
          kind: 'tag-list',
          bytes,
          ifMatch: null,
        });
        expect(res.status).toBe(201);
      }

      const tokens = await mintTokens(h.prisma, {
        libraryId: owner.libraryId,
        libraryKey: owner.libraryKey,
      });
      mcp = await connectMcpClient(h.app, tokens.access_token);
    }, 120_000);

    afterAll(async () => {
      await mcp?.close();
      await h?.close();
    });

    it('advertises the same tools, schemas and descriptions', async () => {
      const listed = await mcp.client.listTools();
      expect(listed.tools.map(normalizeTool)).toEqual(fixture!.expected.tools.map(normalizeTool));
    });

    it('answers every step of the script with the same parsed payload', async () => {
      const { script, expected } = fixture!;
      expect(expected.results).toHaveLength(script.steps.length);
      const mismatches: string[] = [];
      for (const [index, step] of script.steps.entries()) {
        const actual = normalize(await runStep(mcp, step));
        const wanted = normalize(expected.results[index]);
        try {
          expect(actual).toEqual(wanted);
        } catch (err) {
          mismatches.push(
            `step ${index} ${step.name}(${JSON.stringify(step.arguments ?? {})}): ${(err as Error).message}`
          );
        }
      }
      expect(mismatches).toEqual([]);
    }, 120_000);
  }
);
