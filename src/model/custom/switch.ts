/**
 * {@link SwitchEntity} — the reference custom-entity family. A simple on/off
 * switch whose state is the `STATE` boolean data point on its primary channel.
 */

import { CustomEntity } from './base.js';
import { Field } from './fields.js';

export class SwitchEntity extends CustomEntity {
  public readonly kind = 'switch';

  /** True when the underlying STATE data point reads `true`. */
  public get isOn(): boolean {
    return this.dp(Field.STATE)?.value === true;
  }

  /** Turn the switch on. */
  public async turnOn(): Promise<void> {
    await this.write(Field.STATE, true);
  }

  /** Turn the switch off. */
  public async turnOff(): Promise<void> {
    await this.write(Field.STATE, false);
  }
}
