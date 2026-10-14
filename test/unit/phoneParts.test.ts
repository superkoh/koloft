import { describe, expect, it } from 'vitest'
import { tokenFor } from '../../src/main/phone/android'
import type { PhoneDevice, Point, TouchPhase } from '../../src/main/phone/device'
import { pickSimulator } from '../../src/main/phone/ios'
import { MjpegFrames } from '../../src/main/phone/mjpeg'
import { pngSize } from '../../src/main/phone/phones'
import { applyLiveInput } from '../../src/main/phone/screenServer'
import {
  axElements,
  axScreenSize,
  elementAt,
  elementLines,
  type AxNode
} from '../../src/main/phone/screenElements'

const frame = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

const settingsScreen: AxNode[] = [
  {
    type: 'Application',
    AXLabel: 'Settings',
    frame: frame(0, 0, 402, 874),
    children: [
      {
        type: 'Group',
        AXLabel: null,
        frame: frame(0, 0, 402, 874),
        children: [
          {
            type: 'TextField',
            AXLabel: 'Search',
            AXValue: 'battery',
            frame: frame(20, 100, 300, 40)
          },
          { type: 'Button', AXLabel: 'Clear text', frame: frame(330, 100, 40, 40) },
          { type: 'StaticText', AXLabel: 'No  Results\n', frame: frame(0, 300, 402, 20) },
          { type: 'Button', AXLabel: 'hidden', frame: frame(0, 0, 0, 0) }
        ]
      }
    ]
  }
]

describe('iPhone screen elements', () => {
  it('lists named and actionable elements with refs and centre points, and leaves out unnamed groups and the app itself', () => {
    expect(elementLines(axElements(settingsScreen))).toBe(
      [
        '@e1 [text-field] "Search" value="battery" at 170 120',
        '@e2 [button] "Clear text" at 350 120',
        '@e3 [static-text] "No Results" at 201 310'
      ].join('\n')
    )
  })

  it('a ref taps the element of that number in the last snapshot', () => {
    const elements = axElements(settingsScreen)
    expect(elementAt(elements, '@e2')).toMatchObject({ x: 350, y: 120 })
    expect(elementAt(elements, '@e9')).toBeUndefined()
  })

  it('the screen size in points is the root frame', () => {
    expect(axScreenSize(settingsScreen)).toEqual({ width: 402, height: 874 })
  })
})

describe('MJPEG frames from the iPhone stream', () => {
  const part = (jpeg: Buffer): Buffer =>
    Buffer.concat([
      Buffer.from(
        `--mjpegstream\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`
      ),
      jpeg,
      Buffer.from('\r\n')
    ])

  it('yields each JPEG whole, however the bytes are split', () => {
    const a = Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    const b = Buffer.from([0xff, 0xd8, 9, 0x0d, 0x0a, 0x0d, 0x0a, 0xff, 0xd9])
    const all = Buffer.concat([
      Buffer.from(
        'HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=--mjpegstream\r\n\r\n'
      ),
      part(a),
      part(b)
    ])
    const splitter = new MjpegFrames()
    const out: Buffer[] = []
    for (let i = 0; i < all.length; i += 5) out.push(...splitter.push(all.subarray(i, i + 5)))
    expect(out).toEqual([a, b])
  })
})

describe('Android emulator gRPC token', () => {
  it('is read from the discovery file whose gRPC port is ours', () => {
    const other = 'grpc.port=8554\ngrpc.token=theirs\n'
    const ours = 'avd.name=koloft\ngrpc.port=61234\ngrpc.token=abc=def\n'
    expect(tokenFor([other, ours], 61234)).toBe('abc=def')
    expect(tokenFor([other], 61234)).toBeNull()
  })
})

describe('picking an iPhone simulator', () => {
  const sim = (name: string, state = 'Shutdown') => ({ udid: name, name, state })

  it('takes a booted iPhone first, else the first iPhone of the newest iOS', () => {
    const devices = {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-4': [sim('iPhone 16')],
      'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [sim('iPad Pro'), sim('iPhone 17')],
      'com.apple.CoreSimulator.SimRuntime.watchOS-12-0': [sim('Apple Watch')]
    }
    expect(pickSimulator(devices)).toEqual({ udid: 'iPhone 17', name: 'iPhone 17', booted: false })
    devices['com.apple.CoreSimulator.SimRuntime.iOS-26-4'] = [sim('iPhone 16', 'Booted')]
    expect(pickSimulator(devices)).toEqual({ udid: 'iPhone 16', name: 'iPhone 16', booted: true })
    expect(pickSimulator({})).toBeNull()
  })
})

describe('the live screen page', () => {
  function recorder(): PhoneDevice & { touches: [Point, TouchPhase][] } {
    const touches: [Point, TouchPhase][] = []
    return {
      screen: { width: 1080, height: 2400 },
      touches,
      touch: (at: Point, phase: TouchPhase) => touches.push([at, phase])
    } as unknown as PhoneDevice & { touches: [Point, TouchPhase][] }
  }

  it("turns the owner's pointer, given as a share of the picture, into the phone's own units", () => {
    const device = recorder()
    applyLiveInput(device, { t: 'touch', phase: 'down', x: 0.5, y: 0.25 })
    applyLiveInput(device, { t: 'touch', phase: 'up', x: 2, y: 0.25 })
    applyLiveInput(device, { t: 'touch', phase: 'sideways', x: 0.5, y: 0.5 })
    expect(device.touches).toEqual([[{ x: 540, y: 600 }, 'down']])
  })
})

describe('screenshot size', () => {
  it('is read from the PNG header', () => {
    const png = Buffer.alloc(24)
    png.write('IHDR', 12, 'latin1')
    png.writeUInt32BE(1206, 16)
    png.writeUInt32BE(2622, 20)
    expect(pngSize(png)).toEqual({ width: 1206, height: 2622 })
  })
})
