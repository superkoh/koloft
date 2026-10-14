#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const [tool, ...args] = process.argv.slice(2)
const home = process.env.HOME
fs.appendFileSync(path.join(home, 'fake-simulator-calls.txt'), `${tool} ${args.join(' ')}\n`)

const UDID = 'FAKE-IPHONE-17'
const FRAME_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAKKADAAQAAAABAAAAVwAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAVwAoAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMACQkJCQkJEAkJEBYQEBAWHhYWFhYeJh4eHh4eJi4mJiYmJiYuLi4uLi4uLjc3Nzc3N0BAQEBASEhISEhISEhISP/bAEMBCwwMEhESHxERH0szKjNLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS//dAAQAA//aAAwDAQACEQMRAD8A9ikWQriIhW9SMj+lZmsQatNpMsOkypFeFRskYcZzz64yK16KoDxz+xfit/0EE/77H/xNelaJBq8GkxQ6zKkt2AdzqOOvHYZwOtbNFAFGCLUFuHa5ljeEqNiqhVge5LbjnPpir2BRRQB//9D2aiiiqAKKKKACiiigD//R9mopjMVPCk/Ss90v9xKTEDJIHlqeD0HXtVAXvMYS7COD0P4VLWYiX2PnmY8HP7tRz279qVEv1fMkxde4EYH5HJoA0qKYrFuqkfWn0Af/0vZqKKKoAooooAKKKKAP/9P2aiiiqAKKKKACiiigD//U9hdQ+PmZcZ+6cdabFH5TZMjv7Mc/0p9FUBLvFV5IhJNHNvdfL3fKD8rbhj5h3x2p9FAAqhWZsk57HoPpT8imUUAf/9k=',
  'base64'
)
const SHOT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)
const frame = (x, y, width, height) => ({ x, y, width, height })
const SCREEN = [
  {
    type: 'Application',
    AXLabel: 'Home screen',
    frame: frame(0, 0, 402, 874),
    children: [{ type: 'Button', AXLabel: 'Settings', frame: frame(30, 40, 40, 40) }]
  }
]

function xcrun() {
  if (fs.existsSync(path.join(home, 'fake-xcode-missing'))) {
    process.stderr.write(
      'xcrun: error: unable to find utility "simctl", not a developer tool or in PATH\n'
    )
    process.exit(72)
  }
  if (args[0] !== 'simctl') process.exit(1)
  const sub = args[1]
  if (sub === 'list') {
    const devices = {
      'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
        { udid: UDID, name: 'iPhone 17', state: 'Shutdown', isAvailable: true }
      ]
    }
    process.stdout.write(JSON.stringify({ devices }))
  } else if (sub === 'io') {
    fs.writeFileSync(args[args.length - 1], SHOT_PNG)
  }
  process.exit(0)
}

function axe() {
  const sub = args[0]
  if (sub === '--version') process.stdout.write('1.8.0\n')
  else if (sub === 'describe-ui') process.stdout.write(JSON.stringify(SCREEN))
  else if (sub === 'stream-video') {
    process.stdout.write(
      'HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=--mjpegstream\r\n\r\n'
    )
    setInterval(() => {
      process.stdout.write(
        `--mjpegstream\r\nContent-Type: image/jpeg\r\nContent-Length: ${FRAME_JPEG.length}\r\n\r\n`
      )
      process.stdout.write(FRAME_JPEG)
      process.stdout.write('\r\n')
    }, 100)
    return
  }
  process.exit(0)
}

if (tool === 'xcrun') xcrun()
else axe()
