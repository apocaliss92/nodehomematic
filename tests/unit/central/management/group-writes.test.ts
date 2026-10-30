import { describe, it, expect } from 'vitest';
import { CcuManagement } from '../../../../src/central/management/ccu-management.js';
import type { WebUiHttp } from '../../../../src/transport/webui/webui-http.js';
import {
  CcuManagementError,
  GroupWriteVerificationError,
  ValidationError,
} from '../../../../src/support/errors.js';
import { JsonRpcMethod } from '../../../../src/transport/jsonrpc/methods.js';

interface Req {
  kind: 'get' | 'post';
  path: string;
  sid: string;
  body?: string;
}

interface GroupState {
  id: number;
  name: string;
  type: string;
  members: string[];
  /** GROUP_DEVICE_NAME as the CCU reports it; absent on firmware without the suffix. */
  deviceName?: string;
}

/** A tiny HMServer: holds groups, answers create/save/delete, serves groups.gson. */
function server(initial: GroupState[], opts: { dropWrites?: boolean } = {}) {
  const state = [...initial];
  const reqs: Req[] = [];
  const metadata: Record<string, unknown>[] = [];
  const http: WebUiHttp = {
    get: (path, sid) => {
      reqs.push({ kind: 'get', path, sid });
      return Promise.resolve(
        '<html><script>self.groupId = 7;\n self.isNew = ko.observable(true);</script>',
      );
    },
    post: (path, sid, body) => {
      reqs.push({ kind: 'post', path, sid, body });
      const data: Record<string, unknown> = JSON.parse(body);
      if (path.endsWith('/save') && !opts.dropWrites) {
        const id = Number(data['groupId']);
        const next: GroupState = {
          id,
          name: unescape(String(data['groupName'])),
          type: String(data['groupTypeId']),
          members: Array.isArray(data['assignedDevicesIds'])
            ? data['assignedDevicesIds'].map(String)
            : [],
        };
        const at = state.findIndex((g) => g.id === id);
        if (at === -1) state.push(next);
        else state[at] = next;
        return Promise.resolve(JSON.stringify({ isSuccessful: true, content: String(id) }));
      }
      if (path.endsWith('/delete')) {
        const id = Number(data['groupId']);
        const at = state.findIndex((g) => g.id === id);
        const gone = at === -1 ? [] : state.splice(at, 1);
        return Promise.resolve(
          JSON.stringify({
            isSuccessful: true,
            content: JSON.stringify(
              (gone[0]?.members ?? []).map((m) => ({ id: m, name: m, type: 'X' })),
            ),
          }),
        );
      }
      return Promise.resolve(JSON.stringify({ isSuccessful: true, content: '1' }));
    },
  };
  const json = {
    post: (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === JsonRpcMethod.CCU_GET_HEATING_GROUP_LIST) {
        return Promise.resolve(
          JSON.stringify({
            groups: state.map((g) => ({
              id: g.id,
              groupMembers: g.members.map((m) => ({ id: m, memberType: { id: 'T' } })),
              groupType: { id: g.type },
              groupProperties:
                g.deviceName === undefined
                  ? { NAME: g.name }
                  : { NAME: g.name, GROUP_DEVICE_NAME: g.deviceName },
            })),
          }),
        );
      }
      if (method === JsonRpcMethod.DEVICE_GET_REGA_ID_BY_ADDRESS) return Promise.resolve('4711');
      if (method === JsonRpcMethod.INTERFACE_SET_METADATA) {
        metadata.push(params ?? {});
        return Promise.resolve(true);
      }
      return Promise.resolve([]);
    },
  };
  const mgmt = new CcuManagement({
    json,
    webUi: http,
    getSessionId: () => Promise.resolve('SID'),
    interfaceClient: () => undefined,
    configuredInterfaces: () => [],
  });
  return { mgmt, reqs, state, metadata };
}

describe('CcuManagement group writes', () => {
  it('createGroup mirrors the WebUI: GET create for the draft id, POST save, read back', async () => {
    const s = server([]);
    const group = await s.mgmt.createGroup({
      name: 'Büro',
      type: 'hmip.heating.group',
      members: ['000A9D89A7AF25:1'],
    });
    expect(s.reqs[0]).toMatchObject({
      kind: 'get',
      path: '/pages/jpages/group/create',
      sid: 'SID',
    });
    const save = s.reqs[1];
    expect(save).toMatchObject({ kind: 'post', path: '/pages/jpages/group/save' });
    expect(JSON.parse(save?.body ?? '{}')).toEqual({
      groupId: 7,
      groupName: 'B%FCro',
      groupTypeId: 'hmip.heating.group',
      forbidSingleOperation: false,
      assignedDevicesIds: ['000A9D89A7AF25:1'],
      isNewGroup: true,
      groupDeviceName: 'Büro ',
    });
    expect(group).toMatchObject({
      id: 7,
      name: 'Büro',
      members: [{ address: '000A9D89A7AF25:1' }],
    });
    expect(s.metadata).toEqual([{ objectId: '4711', dataId: 'inHeatingGroup', value: 'true' }]);
  });

  it('updateGroup sends isNewGroup=false with the merged name/members and flags removed members', async () => {
    const s = server([
      {
        id: 3,
        name: 'Old',
        type: 'HomeMatic.heating',
        members: ['LEQ1:1', 'LEQ2:1'],
        deviceName: 'Old INT0000003',
      },
    ]);
    const group = await s.mgmt.updateGroup(3, { name: 'New', members: ['LEQ2:1', 'LEQ3:1'] });
    const body = JSON.parse(s.reqs.find((r) => r.kind === 'post')?.body ?? '{}');
    expect(body).toMatchObject({
      groupId: 3,
      groupName: 'New',
      groupTypeId: 'HomeMatic.heating',
      isNewGroup: false,
      assignedDevicesIds: ['LEQ2:1', 'LEQ3:1'],
      groupDeviceName: 'New INT0000003',
    });
    expect(group.name).toBe('New');
    expect(s.metadata.map((m) => m['value'])).toEqual(['true', 'true', 'false']);
  });

  it('updateGroup keeps the plain name when the CCU reports no INT suffix (OpenCCU 3.89)', async () => {
    const s = server([
      { id: 3, name: 'Old', type: 'HomeMatic.heating', members: ['LEQ1:1'], deviceName: 'Old' },
    ]);
    await s.mgmt.updateGroup(3, { name: 'New' });
    const body = JSON.parse(s.reqs.find((r) => r.kind === 'post')?.body ?? '{}');
    expect(body['groupDeviceName']).toBe('New');
  });

  it('deleteGroup posts the id and verifies the group is gone', async () => {
    const s = server([{ id: 3, name: 'G', type: 'HomeMatic.heating', members: ['LEQ1:1'] }]);
    await s.mgmt.deleteGroup(3);
    expect(s.reqs[0]).toMatchObject({ path: '/pages/jpages/group/delete' });
    expect(JSON.parse(s.reqs[0]?.body ?? '{}')).toEqual({ groupId: 3 });
    expect(s.state).toEqual([]);
  });

  it('a write the read-back does not show is a GroupWriteVerificationError', async () => {
    const s = server([], { dropWrites: true });
    await expect(
      s.mgmt.createGroup({ name: 'X', type: 'hmip.heating.group', members: [] }),
    ).rejects.toBeInstanceOf(GroupWriteVerificationError);
  });

  it('validates input before any request', async () => {
    const s = server([{ id: 3, name: 'G', type: 'HomeMatic.heating', members: [] }]);
    await expect(
      s.mgmt.createGroup({ name: '', type: 'hmip.heating.group', members: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      s.mgmt.createGroup({ name: 'A', type: 'nonsense', members: [] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      s.mgmt.createGroup({ name: 'A', type: 'hmip.heating.group', members: ['bad address'] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(s.mgmt.updateGroup(99, { name: 'A' })).rejects.toBeInstanceOf(ValidationError);
    await expect(s.mgmt.deleteGroup(99)).rejects.toBeInstanceOf(ValidationError);
    await expect(s.mgmt.updateGroup(3, {})).rejects.toBeInstanceOf(ValidationError);
    expect(s.reqs).toEqual([]);
  });

  it('a refused save (isSuccessful=false) is a CcuManagementError without the response body', async () => {
    const s = server([]);
    const refusing: WebUiHttp = {
      get: (p, sid) =>
        s.reqs.push({ kind: 'get', path: p, sid }) && Promise.resolve('self.groupId = 7;'),
      post: () =>
        Promise.resolve('{"isSuccessful":false,"errorCode":"42","content":"<html>secret</html>"}'),
    };
    const mgmt = new CcuManagement({
      json: { post: () => Promise.resolve(JSON.stringify({ groups: [] })) },
      webUi: refusing,
      getSessionId: () => Promise.resolve('SID'),
      interfaceClient: () => undefined,
      configuredInterfaces: () => [],
    });
    const err = await mgmt
      .createGroup({ name: 'A', type: 'hmip.heating.group', members: [] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CcuManagementError);
    expect(String((err as Error).message)).toContain('42');
    expect(String((err as Error).message)).not.toContain('secret');
  });
});
