import { create } from 'zustand'

export const useBinding = create<{ open: boolean }>(() => ({ open: false }))

export const openBinding = (open: boolean): void => useBinding.setState({ open })
