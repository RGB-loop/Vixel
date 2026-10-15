import { describe, it, expect } from 'vitest'
import { unpackedAsarPath } from './ffmpegPath'

describe('unpackedAsarPath', () => {
  it('points packaged paths at app.asar.unpacked (spawn cannot run binaries inside app.asar)', () => {
    expect(unpackedAsarPath('/Applications/Vixel.app/Contents/Resources/app.asar/node_modules/ffmpeg-static/ffmpeg'))
      .toBe('/Applications/Vixel.app/Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg')
    expect(unpackedAsarPath('C:\\Program Files\\Vixel\\resources\\app.asar\\node_modules\\ffmpeg-static\\ffmpeg.exe'))
      .toBe('C:\\Program Files\\Vixel\\resources\\app.asar.unpacked\\node_modules\\ffmpeg-static\\ffmpeg.exe')
  })
  it('leaves dev / server paths and already-unpacked paths alone', () => {
    expect(unpackedAsarPath('/repo/node_modules/ffmpeg-static/ffmpeg')).toBe('/repo/node_modules/ffmpeg-static/ffmpeg')
    expect(unpackedAsarPath('/x/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg')).toBe('/x/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg')
  })
})
