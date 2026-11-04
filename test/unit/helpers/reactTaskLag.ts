import { expect } from 'vitest'

const REACT_TASK_LAG_MS = 40
const realSetImmediate = globalThis.setImmediate
let reactTasksLag = false
let laggedTasks = 0
Object.assign(globalThis, {
  setImmediate: (run: (...args: unknown[]) => void, ...args: unknown[]) => {
    if (!reactTasksLag) return realSetImmediate(run, ...args)
    laggedTasks++
    return setTimeout(run, REACT_TASK_LAG_MS, ...args)
  }
})

export const lagReactTasks = (): void => {
  reactTasksLag = true
  laggedTasks = 0
}

export const stopLaggingReactTasks = (): void => {
  reactTasksLag = false
}

export const expectReactTasksLagged = (): void =>
  expect(laggedTasks, 'React’s scheduler went through the lagging setImmediate').toBeGreaterThan(0)
