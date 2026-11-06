import { useCallback, useEffect, useState } from 'react';

import { DeviceList, Page, SecurityCard, StorageCard } from '~/component';
import { Button } from '~/control';
import {
  loadDevices,
  loadLibrary,
  purgeDeleted,
  renameDevice,
  revokeDevice,
  type Device,
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
  // Taken when the devices load, so relative times stay stable between renders.
  const [now, setNow] = useState(Date.now);

  const refreshLibrary = useCallback(async () => {
    const result = await loadLibrary();
    if (result.ok) {
      setLibrary({ value: result.body, failed: false });
    } else {
      setLibrary((prev) => ({ value: prev.value, failed: true }));
      toast("Couldn't load storage", 'error');
    }
  }, [toast]);

  const refreshDevices = useCallback(async () => {
    const result = await loadDevices();
    if (result.ok) {
      setNow(Date.now());
      setDevices({ value: result.body.devices, failed: false });
    } else {
      setDevices((prev) => ({ value: prev.value, failed: true }));
      toast("Couldn't load devices", 'error');
    }
  }, [toast]);

  useEffect(() => {
    void refreshLibrary();
    void refreshDevices();
  }, [refreshLibrary, refreshDevices]);

  const rename = async (id: string, name: string) => {
    const result = await renameDevice(id, name);
    if (!result.ok) {
      toast(
        result.status === 409 ? 'That Mac has been revoked' : "Couldn't rename the Mac",
        'error'
      );
      await refreshDevices();
      return false;
    }
    await refreshDevices();
    return true;
  };

  const revoke = async (id: string) => {
    const result = await revokeDevice(id);
    if (!result.ok) toast("Couldn't revoke the Mac", 'error');
    await refreshDevices();
  };

  const purge = async () => {
    const result = await purgeDeleted();
    if (!result.ok) toast("Couldn't empty the deleted meetings", 'error');
    await refreshLibrary();
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
        <SecurityCard />
      </div>
    </Page>
  );
};
