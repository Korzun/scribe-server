import { api } from './api';

export interface Storage {
  blobBytes: number;
  blobCount: number;
  meetingCount: number;
  deletedMeetingCount: number;
}

export interface Library {
  id: string;
  createdAt: number;
  recoveryCodesRemaining: number;
  storage: Storage;
}

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  isCurrent: boolean;
}

export const loadLibrary = () => api<Library>('/api/v1/library');

export const loadDevices = () => api<{ devices: Device[] }>('/api/v1/devices');

const devicePath = (id: string) => `/api/v1/devices/${encodeURIComponent(id)}`;

export const renameDevice = (id: string, name: string) =>
  api<{ id: string; name: string }>(devicePath(id), {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });

export const revokeDevice = (id: string) => api<undefined>(devicePath(id), { method: 'DELETE' });

export const purgeDeleted = () =>
  api<{ purgedMeetings: number; removedFiles: number }>('/api/v1/library/purge', {
    method: 'POST',
  });

/** One AI assistant the owner approved (spec §10), as the Assistants card lists it. */
export interface Grant {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/** One reprocessing job (spec §8). */
export interface Job {
  id: string;
  meetingId: string;
  reason: string;
  requestedBy: string;
  status: 'queued' | 'leased' | 'done' | 'failed';
  attempts: number;
  leaseDeviceId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  outcome: string | null;
  note: string | null;
}

/** What the admin page shows of the queue: depth and the last few outcomes, nothing more. */
export interface JobsSummary {
  depth: number;
  leased: number;
  recent: Job[];
}

export interface Status {
  libraryExists: boolean;
  version: string;
  publicUrl: string | null;
  /** Whether the remote MCP endpoint is served (PUBLIC_URL is an https origin). */
  mcp: boolean;
}

export const loadGrants = () => api<{ grants: Grant[] }>('/api/v1/mcp/grants');

export const disconnectGrant = (id: string) =>
  api<undefined>(`/api/v1/mcp/grants/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const loadJobs = () => api<JobsSummary>('/api/v1/jobs');

export const loadStatus = () => api<Status>('/api/v1/status');
