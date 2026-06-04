/**
 * {@link IpLockEntity} and {@link RfLockEntity} — the lock custom-entity family.
 *
 * HmIP locks (IP_LOCK) report state via the `LOCK_STATE` string ('LOCKED' /
 * 'UNLOCKED') and are commanded via `LOCK_TARGET_LEVEL` ('LOCKED' / 'UNLOCKED' /
 * 'OPEN'). Classic RF locks (RF_LOCK) report a boolean `STATE` (false = locked,
 * true = unlocked) and expose a separate `OPEN` action.
 *
 * Like every {@link CustomEntity} these own no value state: getters read the
 * underlying data points and commands route writes through the injected writer.
 */

import { CustomEntity } from './base.js';
import { Field } from './fields.js';

/** LOCK_STATE / LOCK_TARGET_LEVEL value: locked. */
const LOCK_LOCKED = 'LOCKED';
/** LOCK_TARGET_LEVEL value: unlocked. */
const LOCK_UNLOCKED = 'UNLOCKED';
/** LOCK_TARGET_LEVEL value: open (latch released). */
const LOCK_OPEN = 'OPEN';

export class IpLockEntity extends CustomEntity {
  public readonly kind = 'lock';

  /** True when LOCK_STATE reads 'LOCKED'. */
  public get isLocked(): boolean {
    return this.dp(Field.LOCK_STATE)?.value === LOCK_LOCKED;
  }

  /** Lock the door (LOCK_TARGET_LEVEL = 'LOCKED'). */
  public async lock(): Promise<void> {
    await this.write(Field.LOCK_TARGET_LEVEL, LOCK_LOCKED);
  }

  /** Unlock the door (LOCK_TARGET_LEVEL = 'UNLOCKED'). */
  public async unlock(): Promise<void> {
    await this.write(Field.LOCK_TARGET_LEVEL, LOCK_UNLOCKED);
  }

  /** Release the latch (LOCK_TARGET_LEVEL = 'OPEN'). */
  public async open(): Promise<void> {
    await this.write(Field.LOCK_TARGET_LEVEL, LOCK_OPEN);
  }
}

export class RfLockEntity extends CustomEntity {
  public readonly kind = 'lock';

  /** True when the boolean STATE is not `true` (false = locked). */
  public get isLocked(): boolean {
    return this.dp(Field.STATE)?.value !== true;
  }

  /** Lock the door (STATE = false). */
  public async lock(): Promise<void> {
    await this.write(Field.STATE, false);
  }

  /** Unlock the door (STATE = true). */
  public async unlock(): Promise<void> {
    await this.write(Field.STATE, true);
  }

  /** Release the latch (OPEN action). */
  public async open(): Promise<void> {
    await this.write(Field.OPEN, true);
  }
}
