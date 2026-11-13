/**
 * Direct links and switch link profiles against an in-process {@link FakeCcu}.
 *
 * The fake HmIP-BS2 below mirrors a real CCU: KEY_TRANSCEIVER `:1`/`:2`, a
 * SWITCH_VIRTUAL_RECEIVER `:4` whose LINK paramset starts at the values the
 * real CCU reported for its default push-button link (toggle / toggle).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCcu } from './fake-ccu/fake-ccu.js';
import { buildFakeFacade, FAKE_PASSWORD, FAKE_USERNAME } from './helpers/build-facade.js';
import type { Homematic } from '../../src/api/homematic.js';
import { switchLinkValues } from '../../src/api/link-profile.js';
import type { HmSwitchLinkActions } from '../../src/api/types.js';
import { ValidationError } from '../../src/support/errors.js';
import type { DeviceDescription, ParameterData } from '../../src/transport/xmlrpc/types.js';

const DEVICE = 'VCU0000002';
const KEY_1 = `${DEVICE}:1`;
const KEY_2 = `${DEVICE}:2`;
const SWITCH = `${DEVICE}:4`;
/** The canned HmIP-SWDO contact: a SHUTTER_CONTACT, outside the catalogue. */
const CONTACT = 'VCU0000001:1';

const BS2: readonly DeviceDescription[] = [
  {
    ADDRESS: DEVICE,
    TYPE: 'HmIP-BS2',
    PARAMSETS: ['MASTER'],
    CHILDREN: [`${DEVICE}:0`, KEY_1, KEY_2, SWITCH],
  },
  { ADDRESS: `${DEVICE}:0`, TYPE: 'MAINTENANCE', PARENT: DEVICE, PARAMSETS: ['MASTER'] },
  { ADDRESS: KEY_1, TYPE: 'KEY_TRANSCEIVER', PARENT: DEVICE, PARAMSETS: ['MASTER', 'LINK'] },
  { ADDRESS: KEY_2, TYPE: 'KEY_TRANSCEIVER', PARENT: DEVICE, PARAMSETS: ['MASTER', 'LINK'] },
  {
    ADDRESS: SWITCH,
    TYPE: 'SWITCH_VIRTUAL_RECEIVER',
    PARENT: DEVICE,
    PARAMSETS: ['VALUES', 'MASTER', 'LINK'],
  },
];

/** Real-CCU default values of the receiver link paramset (per press half). */
const REAL_HALF: Readonly<Record<string, number | boolean>> = {
  COND_VALUE_HI: 150,
  COND_VALUE_LO: 50,
  CT_OFF: 0,
  CT_OFFDELAY: 0,
  CT_ON: 0,
  CT_ONDELAY: 0,
  JT_OFF: 1,
  JT_OFFDELAY: 6,
  JT_ON: 4,
  JT_ONDELAY: 3,
  MULTIEXECUTE: false,
  OFFDELAY_TIME_BASE: 0,
  OFFDELAY_TIME_FACTOR: 0,
  OFF_TIME_BASE: 7,
  OFF_TIME_FACTOR: 31,
  OFF_TIME_MODE: 0,
  ONDELAY_TIME_BASE: 0,
  ONDELAY_TIME_FACTOR: 0,
  ON_TIME_BASE: 7,
  ON_TIME_FACTOR: 31,
  ON_TIME_MODE: 0,
  PROFILE_ACTION_TYPE: 1,
};

function linkDescription(): Record<string, ParameterData> {
  const out: Record<string, ParameterData> = {};
  for (const prefix of ['SHORT', 'LONG']) {
    for (const [param, value] of Object.entries(REAL_HALF)) {
      out[`${prefix}_${param}`] = {
        TYPE: typeof value === 'boolean' ? 'BOOL' : 'INTEGER',
        OPERATIONS: 3,
        DEFAULT: value,
      };
    }
  }
  return out;
}

function newFakeCcu(): FakeCcu {
  return new FakeCcu({
    username: FAKE_USERNAME,
    password: FAKE_PASSWORD,
    extraDevices: BS2,
    extraParamsets: {
      [`${SWITCH}|LINK`]: linkDescription(),
      [`${SWITCH}|VALUES`]: { STATE: { TYPE: 'BOOL', OPERATIONS: 7, FLAGS: 1 } },
    },
  });
}

describe('direct links and switch link profiles (fake CCU)', () => {
  let fakeCcu: FakeCcu;
  let hm: Homematic;

  beforeEach(async () => {
    fakeCcu = newFakeCcu();
    fakeCcu.addDirectLink({
      sender: CONTACT,
      receiver: SWITCH,
      name: 'Door to light',
      description: 'not a push button',
    });
    await fakeCcu.start();
    hm = buildFakeFacade(fakeCcu);
    await hm.start();
  });

  afterEach(async () => {
    await hm.stop();
    await fakeCcu.stop();
  });

  it('adds a link once and lists it with its resolved profile', async () => {
    await hm.addLink(KEY_2, SWITCH, 'Bath', 'Default connection');
    await hm.addLink(KEY_2, SWITCH, 'Bath', 'Default connection');

    expect(fakeCcu.linkCalls().map((c) => c.method)).toEqual(['addLink']);
    expect(fakeCcu.linkCalls()[0]?.params).toEqual([KEY_2, SWITCH, 'Bath', 'Default connection']);
    const links = await hm.listLinks(KEY_2);
    expect(links).toEqual([
      {
        sender: KEY_2,
        receiver: SWITCH,
        name: 'Bath',
        description: 'Default connection',
        profile: { kind: 'switch', short: 'toggle', long: 'toggle' },
      },
    ]);
  });

  it('lists every link of a device, a non-switch pair with profile null', async () => {
    await hm.addLink(KEY_1, SWITCH);
    const links = await hm.listLinks(DEVICE);
    expect(links.map((l) => [l.sender, l.receiver, l.profile])).toEqual(
      expect.arrayContaining([
        [KEY_1, SWITCH, { kind: 'switch', short: 'toggle', long: 'toggle' }],
        [CONTACT, SWITCH, null],
      ]),
    );
    expect(await hm.getLinkProfile(CONTACT, SWITCH)).toBeNull();
  });

  it('removes a link, and removing an absent link makes no call', async () => {
    await hm.addLink(KEY_1, SWITCH);
    await hm.removeLink(KEY_1, SWITCH);
    await hm.removeLink(KEY_1, SWITCH);

    expect(fakeCcu.linkCalls().map((c) => c.method)).toEqual(['addLink', 'removeLink']);
    expect(await hm.listLinks(KEY_1)).toEqual([]);
  });

  it('writes exactly the catalogue values and reads the profile back', async () => {
    await hm.addLink(KEY_1, SWITCH);
    await hm.setLinkProfile(KEY_1, SWITCH, { short: 'on', long: 'none' });

    const put = fakeCcu.linkCalls().filter((c) => c.method === 'putParamset');
    expect(put).toHaveLength(1);
    expect(put[0]?.params).toEqual([
      SWITCH,
      KEY_1,
      switchLinkValues({ short: 'on', long: 'none' }),
    ]);
    expect(await hm.getLinkProfile(KEY_1, SWITCH)).toEqual({
      kind: 'switch',
      short: 'on',
      long: 'none',
    });
  });

  it('reads a timed link as custom and refuses to rewrite it', async () => {
    await hm.addLink(KEY_1, SWITCH);
    fakeCcu.setLinkParamset(SWITCH, KEY_1, { SHORT_ON_TIME_BASE: 4, SHORT_ON_TIME_FACTOR: 3 });

    expect(await hm.getLinkProfile(KEY_1, SWITCH)).toEqual({ kind: 'custom' });
    await expect(
      hm.setLinkProfile(KEY_1, SWITCH, { short: 'toggle', long: 'toggle' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fakeCcu.linkCalls().map((c) => c.method)).toEqual(['addLink']);
  });

  it('refuses a profile on a non-switch pair or a missing link, without a write', async () => {
    await expect(
      hm.setLinkProfile(CONTACT, SWITCH, { short: 'on', long: 'on' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      hm.setLinkProfile(KEY_2, SWITCH, { short: 'on', long: 'on' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(hm.getLinkProfile(KEY_2, SWITCH)).rejects.toBeInstanceOf(ValidationError);
    expect(fakeCcu.linkCalls()).toEqual([]);
  });

  it('refuses unknown channels and press actions before any call', async () => {
    await expect(hm.addLink('NOPE000001:1', SWITCH)).rejects.toBeInstanceOf(ValidationError);
    await expect(hm.listLinks('NOPE000001')).rejects.toBeInstanceOf(ValidationError);
    // A caller without the types (plain JavaScript, a JSON request) can send anything.
    const untyped: HmSwitchLinkActions = JSON.parse('{"short":"on","long":"dim"}');
    await expect(hm.setLinkProfile(KEY_1, SWITCH, untyped)).rejects.toBeInstanceOf(ValidationError);
    expect(fakeCcu.linkCalls()).toEqual([]);
  });
});
