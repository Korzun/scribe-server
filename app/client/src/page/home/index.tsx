import { useState } from 'react';

import { Card, Page } from '~/component';
import { Button } from '~/control';
import { useAuth } from '~/provider/auth';

/** Placeholder dashboard: Task 12 replaces it with devices and storage. */
export const HomePage = () => {
  const { signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <Page>
      <Card
        title="Scribe vault"
        headerAction={
          <Button
            loading={signingOut}
            onClick={() => {
              setSigningOut(true);
              void signOut();
            }}
          >
            Sign out
          </Button>
        }
      >
        Signed in. Devices and storage arrive in Task 12.
      </Card>
    </Page>
  );
};
