import { describe, it, expect } from 'vitest'
import { loopbackHost } from './app'

describe('loopbackHost (DNS rebinding guard for the password-less local API)', () => {
  it('accepts loopback hosts with or without a port', () => {
    for (const h of ['localhost', 'localhost:41721', '127.0.0.1:41721', '[::1]:41721', 'LOCALHOST:41721']) {
      expect(loopbackHost(h), h).toBe(true)
    }
  })
  it('rejects rebinding hosts, LAN addresses and missing Host', () => {
    for (const h of ['evil.com:41721', 'localhost.evil.com', '127.0.0.1.nip.io:41721', '192.168.1.15:41721', '', undefined]) {
      expect(loopbackHost(h as string | undefined), String(h)).toBe(false)
    }
  })
})
