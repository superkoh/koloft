const shiftMs = Number(process.env.KOLOFT_E2E_CLOCK_SHIFT_MS)
if (Number.isFinite(shiftMs) && shiftMs !== 0) {
  const RealDate = Date
  const shiftedNow = () => RealDate.now() + shiftMs
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(shiftedNow()).toString()
    return args.length === 0 ? new RealDate(shiftedNow()) : new RealDate(...args)
  }
  ShiftedDate.prototype = RealDate.prototype
  ShiftedDate.now = shiftedNow
  ShiftedDate.parse = RealDate.parse
  ShiftedDate.UTC = RealDate.UTC
  globalThis.Date = ShiftedDate
}
