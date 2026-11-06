import { Card } from '../card';
import { useStyle } from './style';

/** Placeholder: the next step puts password and recovery-code controls here. */
export const SecurityCard = () => {
  const styles = useStyle();
  return (
    <Card title="Security">
      <div className={styles.body}>Password and recovery codes — coming in the next step.</div>
    </Card>
  );
};
