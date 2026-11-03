import './styles.css'
import './workbench.css'
import './signInBar.css'
import { ICON_PATHS } from './icons/paths'
import type { AddressSecurity } from '@shared/signInAddress'

function iconSvg(name: keyof typeof ICON_PATHS): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('fill-rule', 'evenodd')
  path.setAttribute('d', ICON_PATHS[name])
  svg.appendChild(path)
  return svg
}

const secure = document.getElementById('secure')!
const notSecure = document.getElementById('not-secure')!
const address = document.getElementById('address') as HTMLInputElement
secure.appendChild(iconSvg('lock'))
notSecure.prepend(iconSvg('warning'))

function show(state: { url: string; security: AddressSecurity }): void {
  address.value = state.url
  secure.classList.toggle('on', state.security === 'secure')
  notSecure.classList.toggle('on', state.security === 'not-secure')
}

Object.assign(window, { show })
