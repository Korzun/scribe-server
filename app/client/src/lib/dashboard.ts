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
