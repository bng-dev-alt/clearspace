import { describe, it, expect } from 'vitest';
import { loopbackOnly } from '../../../scripts/docker-loopback-proxy.mjs';

describe('docker loopback proxy (scoped, S1 stack only)', () => {
  it('pins every published port of a container-create body to 127.0.0.1, leaving the rest unchanged', () => {
    const out = JSON.parse(loopbackOnly(JSON.stringify({ Image: 'kong', Env: ['A=1'], HostConfig: { Binds: ['/x:/y'], PortBindings: { '8000/tcp': [{ HostPort: '55521' }], '5432/tcp': [{ HostIp: '', HostPort: '55522' }, { HostIp: '::', HostPort: '55522' }] } } })));
    expect(out.HostConfig.PortBindings['8000/tcp']).toEqual([{ HostIp: '127.0.0.1', HostPort: '55521' }]);
    expect(out.HostConfig.PortBindings['5432/tcp'].every((b: { HostIp: string }) => b.HostIp === '127.0.0.1')).toBe(true);
    expect(out.Image).toBe('kong'); expect(out.Env).toEqual(['A=1']); expect(out.HostConfig.Binds).toEqual(['/x:/y']);
  });
  it('leaves containers without published ports alone', () => {
    expect(JSON.parse(loopbackOnly('{"Image":"rest","HostConfig":{}}'))).toEqual({ Image: 'rest', HostConfig: {} });
    expect(JSON.parse(loopbackOnly('{"Image":"rest"}'))).toEqual({ Image: 'rest' });
  });
});
