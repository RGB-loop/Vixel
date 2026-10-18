import { describe, it, expect } from 'vitest'
import { networkInterfaces } from 'node:os'
import type { IncomingMessage } from 'node:http'
import { isLocalRequest, loopbackHost } from './app'
import { renderOpenedPage } from './webapp'

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

describe('isLocalRequest (who gets "open in Vixel" instead of the web view)', () => {
  const from = (remoteAddress: string) => ({ socket: { remoteAddress } }) as Pick<IncomingMessage, 'socket'>
  it('treats loopback (incl. IPv4-mapped) and this machine\'s own interface addresses as local', () => {
    expect(isLocalRequest(from('127.0.0.1'))).toBe(true)
    expect(isLocalRequest(from('::ffff:127.0.0.1'))).toBe(true)
    expect(isLocalRequest(from('::1'))).toBe(true)
    const own = Object.values(networkInterfaces()).flat().find((a) => a && !a.internal)
    if (own) expect(isLocalRequest(from(own.address))).toBe(true)
  })
  it('treats other devices as remote', () => {
    expect(isLocalRequest(from('203.0.113.7'))).toBe(false)
    expect(isLocalRequest(from(''))).toBe(false)
  })
})

describe('renderOpenedPage', () => {
  it('is a script-free page in the requested language', () => {
    const zh = renderOpenedPage('zh', true)
    expect(zh).toContain('已在 Vixel 中打开')
    expect(zh).not.toMatch(/<script/i)
    expect(renderOpenedPage('en', false)).toContain('not in this library')
  })
})
