import { useCallback } from 'react';

import { useToast } from '~/provider/toast';

import { Button } from '../button';
import { useModalDialog } from '../use-modal-dialog';
import { useStyle } from './style';

type CodesSheetProps = {
  isOpen: boolean;
  codes: string[];
  /** The only way out: the owner says the codes are saved. */
  onDone: () => void;
};

const FILE_NAME = 'scribe-recovery-codes.txt';
const WARNING = 'Your old codes no longer work. Each code needs your Secret Key.';

const fileText = (codes: string[]) =>
  `Scribe recovery codes\n\n${codes.join('\n')}\n\n${WARNING}\nEach code works once.\n`;

const noop = () => {};

/**
 * Shows freshly generated recovery codes, the one time they exist outside
 * the owner's keeping. It cannot be dismissed by Escape or a backdrop click;
 * only "I've saved them" closes it.
 */
export const CodesSheet = ({ isOpen, codes, onDone }: CodesSheetProps) => {
  const styles = useStyle();
  const toast = useToast();
  const modalRef = useModalDialog(isOpen, noop, false);
  const stop = useCallback((event: React.MouseEvent) => event.stopPropagation(), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      toast('Codes copied', 'success');
    } catch {
      toast("Couldn't copy — select the codes and copy them by hand", 'error');
    }
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([fileText(codes)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = FILE_NAME;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <dialog ref={modalRef} className={styles.root} onClick={stop}>
      <div className={styles.header}>Your new recovery codes</div>
      <div className={styles.body}>
        <p className={styles.warning}>{WARNING}</p>
        <ul className={styles.codes}>
          {codes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <div className={styles.actions}>
          <Button onClick={() => void copy()}>Copy</Button>
          <Button onClick={download}>Download .txt</Button>
        </div>
      </div>
      <div className={styles.footer}>
        <Button type="primary" radius="modal" onClick={onDone}>
          I&apos;ve saved them
        </Button>
      </div>
    </dialog>
  );
};
