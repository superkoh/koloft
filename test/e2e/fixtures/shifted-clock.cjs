const shiftMs = Number(process.env.KOLOFT_E2E_CLOCK_SHIFT_MS)
if (Number.isFinite(shiftMs) && shiftMs !== 0) {
  const RealDate = Date
  const shiftedNow = () => RealDate.now() + shiftMs
  function ShiftedDate(...args) {
    if (!new.target) return new RealDate(shiftedNow()).toString()
    return Reflect.construct(RealDate, args.length === 0 ? [shiftedNow()] : args, new.target)
  }
  ShiftedDate.prototype = RealDate.prototype
  ShiftedDate.now = shiftedNow
  ShiftedDate.parse = RealDate.parse
  ShiftedDate.UTC = RealDate.UTC
  globalThis.Date = ShiftedDate
}
