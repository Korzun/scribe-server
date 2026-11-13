import { useCallback, useEffect, useRef, useState } from 'react';

import { AssistantsCard, DeviceList, JobsCard, Page, SecurityCard, StorageCard } from '~/component';
import { Button } from '~/control';
import {
  disconnectGrant,
  loadDevices,
  loadGrants,
  loadJobs,
  loadLibrary,
  loadStatus,
  purgeDeleted,
  renameDevice,
  revokeDevice,
  type Device,
  type Grant,
  type JobsSummary,
  type Library,
} from '~/lib/dashboard';
import { useAuth } from '~/provider/auth';
import { useToast } from '~/provider/toast';

import { useStyle } from './style';

type Loaded<T> = { value?: T; failed: boolean };

export const DashboardPage = () => {
  const styles = useStyle();
  const { signOut } = useAuth();
  const toast = useToast();
  const [signingOut, setSigningOut] = useState(false);
  const [library, setLibrary] = useState<Loaded<Library>>({ failed: false });
  const [devices, setDevices] = useState<Loaded<Device[]>>({ failed: false });
  const [grants, setGrants] = useState<Loaded<Grant[]>>({ failed: false });
  const [jobs, setJobs] = useState<Loaded<JobsSummary>>({ failed: false });
  // Whether /mcp is served; undefined until the status answers. Explains an
  // empty Assistants card.
  const [mcp, setMcp] = useState<boolean | undefined>();
  // Taken when the devices load, so relative times stay stable between renders.
  const [now, setNow] = useState(Date.now);

  // Only the latest request per resource may write state, and nothing writes
  // after unmount.
  const libraryRequest = useRef(0);
  const devicesRequest = useRef(0);
  const grantsRequest = useRef(0);
  const jobsRequest = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshLibrary = useCallback(async () => {
    const request = ++libraryRequest.current;
    const result = await loadLibrary();
    if (!mounted.current || request !== libraryRequest.current) return;
    if (result.ok) {
      setLibrary({ value: result.body, failed: false });
    } else {
      setLibrary((prev) => ({ value: prev.value, failed: true }));
      toast("Couldn't load storage", 'error');
    }
  }, [toast]);

  const refreshDevices = useCallback(async () => {
    const request = ++devicesRequest.current;
    const result = await loadDevices();
    if (!mounted.current || request !== devicesRequest.current) return;
    if (result.ok) {
      setNow(Date.now());
      setDevices({ value: result.body.devices, failed: false });
    } else {
      setDevices((prev) => ({ value: prev.value, failed: true }));
      toast("Couldn't load devices", 'error');
    }
  }, [toast]);

  const refreshGrants = useCallback(async () => {
    const request = ++grantsRequest.current;
    const [result, status] = await Promise.all([loadGrants(), loadStatus()]);
    if (!mounted.current || request !== grantsRequest.current) return;
    if (status.ok) setMcp(status.body.mcp);
    if (result.ok) {
      setGrants({ value: result.body.grants, failed: false });
    } else {
      setGrants((prev) => ({ value: prev.value, failed: true }));
      toast("Couldn't load assistants", 'error');
    }
  }, [toast]);

  const refreshJobs = useCallback(async () => {
    const request = ++jobsRequest.current;
    const result = await loadJobs();
    if (!mounted.current || request !== jobsRequest.current) return;
    if (result.ok) {
      setJobs({ value: result.body, failed: false });
    } else {
      setJobs((prev) => ({ value: prev.value, failed: true }));
      toast("Couldn't load jobs", 'error');
    }
  }, [toast]);

  const refreshAll = useCallback(
    () =>
      Promise.all([refreshLibrary(), refreshDevices(), refreshGrants(), refreshJobs()]).then(
        () => undefined
      ),
    [refreshLibrary, refreshDevices, refreshGrants, refreshJobs]
  );

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const rename = async (id: string, name: string) => {
    const result = await renameDevice(id, name);
    if (!result.ok) {
      toast(
        result.status === 409 ? 'That Mac has been revoked' : "Couldn't rename the Mac",
        'error'
      );
    }
    await refreshAll();
    return result.ok;
  };

  const revoke = async (id: string) => {
    const result = await revokeDevice(id);
    if (!result.ok) toast("Couldn't revoke the Mac", 'error');
    await refreshAll();
  };

  const purge = async () => {
    const result = await purgeDeleted();
    if (!result.ok) toast("Couldn't empty the deleted meetings", 'error');
    await refreshAll();
  };

  const disconnect = async (id: string) => {
    const result = await disconnectGrant(id);
    if (!result.ok) toast("Couldn't disconnect the assistant", 'error');
    await refreshAll();
  };

  return (
    <Page
      header={
        <div className={styles.header}>
          <h1 className={styles.heading}>Scribe vault</h1>
          <Button
            loading={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOut();
            }}
          >
            Sign out
          </Button>
        </div>
      }
    >
      <div className={styles.stack}>
        <StorageCard
          storage={library.value?.storage}
          failed={library.failed && !library.value}
          onPurge={purge}
        />
        <DeviceList
          devices={devices.value}
          failed={devices.failed && !devices.value}
          now={now}
          onRename={rename}
          onRevoke={revoke}
        />
        <AssistantsCard
          grants={grants.value}
          failed={grants.failed && !grants.value}
          mcpEnabled={mcp}
          now={now}
          onDisconnect={disconnect}
        />
        <JobsCard jobs={jobs.value} failed={jobs.failed && !jobs.value} now={now} />
        <SecurityCard
          recoveryCodesRemaining={library.value?.recoveryCodesRemaining}
          onChanged={() => void refreshAll()}
        />
      </div>
    </Page>
  );
};
