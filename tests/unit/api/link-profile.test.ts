import { describe, expect, it } from 'vitest';
import {
  classifyLinkParamset,
  isSwitchLinkPair,
  parseLinks,
  switchLinkValues,
} from '../../../src/api/link-profile.js';
import type { HmLinkPressAction } from '../../../src/api/types.js';

/**
 * The receiver link paramset read from a real CCU (HmIP-BS2 `:4` ← `:2`,
 * "Default connection Push button - Switch actuator"): XML-RPC
 * `getParamset(receiver, sender)`. Enums arrive as integers, MULTIEXECUTE as a
 * boolean.
 */
const REAL_DEFAULT_LINK: Record<string, unknown> = {
  SHORT_CT_ON: 0,
  LONG_PROFILE_ACTION_TYPE: 1,
  LONG_OFF_TIME_MODE: 0,
  SHORT_OFFDELAY_TIME_BASE: 0,
  SHORT_JT_OFFDELAY: 6,
  LONG_CT_OFFDELAY: 0,
  LONG_CT_OFF: 0,
  SHORT_COND_VALUE_LO: 50,
  SHORT_OFFDELAY_TIME_FACTOR: 0,
  LONG_JT_ON: 4,
  LONG_OFF_TIME_FACTOR: 31,
  SHORT_COND_VALUE_HI: 150,
  SHORT_OFF_TIME_MODE: 0,
  SHORT_CT_ONDELAY: 0,
  SHORT_OFF_TIME_FACTOR: 31,
  LONG_MULTIEXECUTE: false,
  LONG_ONDELAY_TIME_FACTOR: 0,
  SHORT_ON_TIME_FACTOR: 31,
  LONG_ON_TIME_FACTOR: 31,
  LONG_CT_ONDELAY: 0,
  SHORT_ON_TIME_BASE: 7,
  SHORT_MULTIEXECUTE: false,
  LONG_JT_OFF: 1,
  SHORT_JT_ONDELAY: 3,
  LONG_ONDELAY_TIME_BASE: 0,
  SHORT_PROFILE_ACTION_TYPE: 1,
  LONG_ON_TIME_MODE: 0,
  LONG_JT_OFFDELAY: 6,
  LONG_OFF_TIME_BASE: 7,
  LONG_OFFDELAY_TIME_FACTOR: 0,
  LONG_COND_VALUE_LO: 50,
  SHORT_OFF_TIME_BASE: 7,
  SHORT_ON_TIME_MODE: 0,
  LONG_JT_ONDELAY: 3,
  LONG_COND_VALUE_HI: 150,
  SHORT_CT_OFF: 0,
  LONG_ON_TIME_BASE: 7,
  SHORT_JT_OFF: 1,
  SHORT_ONDELAY_TIME_FACTOR: 0,
  LONG_CT_ON: 0,
  SHORT_ONDELAY_TIME_BASE: 0,
  LONG_OFFDELAY_TIME_BASE: 0,
  SHORT_CT_OFFDELAY: 0,
  SHORT_JT_ON: 4,
};

const ACTIONS: readonly HmLinkPressAction[] = ['toggle', 'on', 'off', 'none'];

describe('link profile catalogue', () => {
  it('reads the real CCU default push-button link as toggle / toggle', () => {
    expect(classifyLinkParamset(REAL_DEFAULT_LINK)).toEqual({
      kind: 'switch',
      short: 'toggle',
      long: 'toggle',
    });
  });

  it('round-trips every short × long combination through its written values', () => {
    for (const short of ACTIONS) {
      for (const long of ACTIONS) {
        const written = { ...REAL_DEFAULT_LINK, ...switchLinkValues({ short, long }) };
        expect(classifyLinkParamset(written)).toEqual({ kind: 'switch', short, long });
      }
    }
  });

  it('writes MULTIEXECUTE as a boolean and the jump tables as integers', () => {
    const values = switchLinkValues({ short: 'on', long: 'off' });
    expect(values['SHORT_MULTIEXECUTE']).toBe(false);
    expect(values['SHORT_JT_OFF']).toBe(1);
    expect(values['SHORT_JT_OFFDELAY']).toBe(3);
    expect(values['LONG_JT_ON']).toBe(4);
    expect(values['LONG_PROFILE_ACTION_TYPE']).toBe(1);
  });

  it('writes only PROFILE_ACTION_TYPE = 0 for none', () => {
    const values = switchLinkValues({ short: 'none', long: 'none' });
    expect(values).toEqual({ SHORT_PROFILE_ACTION_TYPE: 0, LONG_PROFILE_ACTION_TYPE: 0 });
  });

  it('reads a link with a timer as custom', () => {
    // A staircase light: on for 3 minutes. OCCU's "on" profile, but the on-time
    // is not the value the catalogue writes, so it must never be rewritten.
    const timed = {
      ...REAL_DEFAULT_LINK,
      ...switchLinkValues({ short: 'on', long: 'on' }),
      SHORT_ON_TIME_BASE: 4,
      SHORT_ON_TIME_FACTOR: 3,
    };
    expect(classifyLinkParamset(timed)).toEqual({ kind: 'custom' });
  });

  it('reads an OCCU alternative jump value as custom', () => {
    // KEY_TRANSCEIVER.tcl PROFILE_1 accepts SHORT_JT_OFF {1 3 5}; only 1 is written.
    const alternative = {
      ...REAL_DEFAULT_LINK,
      ...switchLinkValues({ short: 'on', long: 'on' }),
      SHORT_JT_OFF: 5,
    };
    expect(classifyLinkParamset(alternative)).toEqual({ kind: 'custom' });
  });

  it('reads PROFILE_ACTION_TYPE_TOGGLE (2) as custom', () => {
    expect(classifyLinkParamset({ ...REAL_DEFAULT_LINK, SHORT_PROFILE_ACTION_TYPE: 2 })).toEqual({
      kind: 'custom',
    });
  });

  it('reads a paramset missing a catalogue parameter as custom', () => {
    const missing = { ...REAL_DEFAULT_LINK };
    delete missing['LONG_JT_ON'];
    expect(classifyLinkParamset(missing)).toEqual({ kind: 'custom' });
    expect(classifyLinkParamset({})).toEqual({ kind: 'custom' });
  });

  it('applies only to a KEY_TRANSCEIVER sender and a SWITCH_VIRTUAL_RECEIVER receiver', () => {
    expect(isSwitchLinkPair('KEY_TRANSCEIVER', 'SWITCH_VIRTUAL_RECEIVER')).toBe(true);
    expect(isSwitchLinkPair('KEY_TRANSCEIVER', 'DIMMER_VIRTUAL_RECEIVER')).toBe(false);
    expect(isSwitchLinkPair('MOTIONDETECTOR_TRANSCEIVER', 'SWITCH_VIRTUAL_RECEIVER')).toBe(false);
    expect(isSwitchLinkPair(undefined, 'SWITCH_VIRTUAL_RECEIVER')).toBe(false);
  });
});

describe('parseLinks', () => {
  it('keeps NAME and DESCRIPTION, defaulting both to ""', () => {
    expect(
      parseLinks([
        {
          SENDER: 'A:1',
          RECEIVER: 'A:4',
          FLAGS: 0,
          NAME: 'Bath',
          DESCRIPTION: 'Default connection Push button  - Switch actuator',
        },
        { SENDER: 'A:2', RECEIVER: 'A:4' },
        { SENDER: 'A:3' },
        'garbage',
      ]),
    ).toEqual([
      {
        sender: 'A:1',
        receiver: 'A:4',
        name: 'Bath',
        description: 'Default connection Push button  - Switch actuator',
      },
      { sender: 'A:2', receiver: 'A:4', name: '', description: '' },
    ]);
    expect(parseLinks('nope')).toEqual([]);
  });
});
