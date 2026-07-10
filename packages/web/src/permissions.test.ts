import { describe, expect, it } from 'vitest'
import { deniedMedia } from 'meetcap-capture'
import { getPermissionStatus, mapPermissionState } from './permissions'

describe('mapPermissionState', () => {
  it('keeps the shared vocabulary identical to the Electron side', () => {
    expect(mapPermissionState('granted')).toBe('granted')
    expect(mapPermissionState('denied')).toBe('denied')
    expect(mapPermissionState('prompt')).toBe('not-determined')
    expect(mapPermissionState('weird')).toBe('unknown')
  })
})

describe('getPermissionStatus', () => {
  it('maps Permissions API states into a web snapshot', async () => {
    const status = await getPermissionStatus(async (name) => ({
      state: name === 'microphone' ? 'granted' : 'denied',
    }))
    expect(status).toEqual({ platform: 'web', screen: 'unknown', microphone: 'granted', camera: 'denied' })
  })

  it('degrades to unknown when the Permissions API rejects (older Safari)', async () => {
    const status = await getPermissionStatus(async () => {
      throw new Error('unsupported')
    })
    expect(status.microphone).toBe('unknown')
    expect(status.camera).toBe('unknown')
  })

  it('works with deniedMedia — a prompt-able mic is not blocking, a denied camera only blocks camera recordings', async () => {
    const status = await getPermissionStatus(async (name) => ({
      state: name === 'microphone' ? 'prompt' : 'denied',
    }))
    expect(deniedMedia(status)).toEqual([])
    expect(deniedMedia(status, true)).toEqual(['camera'])
  })
})
