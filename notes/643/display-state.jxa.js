ObjC.import('CoreGraphics')
const asleep = $.CGDisplayIsAsleep($.CGMainDisplayID())
const session = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary()) || {}
JSON.stringify({ displayAsleep: asleep, screenLocked: !!session.CGSSessionScreenIsLocked })
