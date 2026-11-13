/**
 * The one place the vault reads plaintext (spec §10): inside an MCP call,
 * with the Library Key an access token's wrap just opened. A reader is built
 * per request around that key, reads the current revision of a blob, opens it
 * under the AAD the Mac sealed it with, and parses the JSON. It holds the key
 * only by reference; the caller (`withLibraryKey`) zeroes it when the call
 * ends, after which every read here fails and yields `null`.
 *
 * Absence is a normal state, not an error: a meeting between `stop()` and the
 * end of processing has a manifest and nothing else. A blob that does not
 * open (a wrong key, a tampered byte, a parse failure) is also `null`, so one
 * bad file hides one artifact rather than the corpus, as Scribe's own listing
 * behaves. Nothing here logs: a log line about a plaintext read is one step
 * from a log line of plaintext.
 */
import type { PrismaClient } from '@prisma/client';

import { blobAad, open } from '../crypto/seal';
import type { BlobStore } from '../services/blob-store';
import { getBlob, LIBRARY_SCOPE } from '../services/blobs';
import type {
  Manifest,
  MeetingSummaryFile,
  MeetingTagsFile,
  SpeakerInferencesFile,
  SpeakerLabelsFile,
  TagListFile,
  Transcript,
} from './artifacts';

export type LibraryReader = {
  /** Every live meeting that has a manifest blob, canonical lowercase ids, sorted. */
  listMeetingIds(): Promise<string[]>;
  manifest(meetingId: string): Promise<Manifest | null>;
  transcript(meetingId: string): Promise<Transcript | null>;
  labels(meetingId: string): Promise<SpeakerLabelsFile | null>;
  inferences(meetingId: string): Promise<SpeakerInferencesFile | null>;
  summary(meetingId: string): Promise<MeetingSummaryFile | null>;
  meetingTags(meetingId: string): Promise<MeetingTagsFile | null>;
  /** The library-wide tag list, or `null` when none has been written. */
  tagList(): Promise<TagListFile | null>;
};

export type LibraryReaderDeps = {
  prisma: PrismaClient;
  blobStore: BlobStore;
  libraryId: string;
  /** Borrowed, not owned: zeroed by the caller when the MCP call ends. */
  libraryKey: Buffer;
};

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function createLibraryReader(deps: LibraryReaderDeps): LibraryReader {
  const { prisma, blobStore, libraryId, libraryKey } = deps;

  async function readJson<T>(scope: string, kind: string): Promise<T | null> {
    const blob = await getBlob({ prisma, blobStore }, scope, kind);
    if (blob === null) return null;
    try {
      const sealed = await collect(await blob.openStream());
      const plain = open(libraryKey, sealed, blobAad(libraryId, scope, kind, blob.revision));
      return JSON.parse(plain.toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  // A tombstoned meeting is no longer the library's (spec §6), whatever blobs
  // still wait on disk for the collector: its artifacts read as absent.
  const meetingJson =
    <T>(kind: string) =>
    async (meetingId: string): Promise<T | null> => {
      if (meetingId === LIBRARY_SCOPE) return null;
      const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
      if (meeting === null || meeting.deletedAt !== null) return null;
      return readJson<T>(meetingId, kind);
    };

  return {
    async listMeetingIds() {
      const [live, manifests] = await Promise.all([
        prisma.meeting.findMany({ where: { deletedAt: null }, select: { id: true } }),
        prisma.blob.findMany({ where: { kind: 'manifest' }, select: { scope: true } }),
      ]);
      const withManifest = new Set(manifests.map((b) => b.scope));
      return live
        .map((m) => m.id)
        .filter((id) => withManifest.has(id))
        .sort();
    },
    manifest: meetingJson<Manifest>('manifest'),
    transcript: meetingJson<Transcript>('transcript'),
    labels: meetingJson<SpeakerLabelsFile>('labels'),
    inferences: meetingJson<SpeakerInferencesFile>('inferences'),
    summary: meetingJson<MeetingSummaryFile>('summary'),
    meetingTags: meetingJson<MeetingTagsFile>('tags'),
    tagList: () => readJson<TagListFile>(LIBRARY_SCOPE, 'tag-list'),
  };
}
