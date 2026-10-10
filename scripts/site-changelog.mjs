import fs from 'node:fs'

const REPO = 'https://github.com/superkoh/koloft'
const RELEASES = 'https://github.com/superkoh/koloft-releases/releases/tag/'
const PLACEHOLDER = '<!-- releases -->'
const INSTALL_MARKER = '<!-- koloft:install -->'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function toHtml(text) {
  let html = ''
  let last = 0
  for (const match of text.matchAll(/(https:\/\/[^\s<>"'()]+[^\s<>"'().,])|#(\d+)/g)) {
    const [whole, url, number] = match
    const link = url
      ? `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`
      : `<a href="${REPO}/issues/${number}">#${number}</a>`
    html += escapeHtml(text.slice(last, match.index)) + link
    last = match.index + whole.length
  }
  return html + escapeHtml(text.slice(last))
}

function changesOf(body) {
  const groups = { new: [], fixed: [], faster: [], also: [] }
  const groupOfType = { feat: 'new', fix: 'fixed', perf: 'faster' }
  for (const line of (body ?? '').split(INSTALL_MARKER)[0].split('\n')) {
    const item = line.match(/^- (.+)$/)?.[1]
    if (!item) continue
    const typed = item.match(/^(feat|fix|perf)(?:\(([^)]*)\))?: (.+)$/)
    if (typed) groups[groupOfType[typed[1]]].push({ scope: typed[2], text: typed[3] })
    else groups.also.push({ text: item })
  }
  return groups
}

function renderItem({ scope, text }) {
  const label = scope ? `<span class="why">${escapeHtml(scope)} ·</span> ` : ''
  return `<li>${label}${toHtml(text)}</li>`
}

function renderRelease(release) {
  const date = new Date(release.published_at)
  const day = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`
  const tag = escapeHtml(release.tag_name)
  const lists = Object.entries(changesOf(release.body))
    .filter(([, items]) => items.length)
    .map(
      ([heading, items]) =>
        `<h3>${heading}</h3>\n<ul class="dash">\n${items.map(renderItem).join('\n')}\n</ul>`
    )
  return [
    `<h2 id="${tag}">${tag}</h2>`,
    `<p class="why">${day} · <a href="${RELEASES}${tag}">download page</a></p>`,
    ...(lists.length ? lists : ['<p>No change notes for this version.</p>'])
  ].join('\n')
}

function renderChangelog(template, releasePages) {
  if (!template.includes(PLACEHOLDER)) throw new Error(`the page has no ${PLACEHOLDER} line`)
  const releases = releasePages.flat().sort((a, b) => b.published_at.localeCompare(a.published_at))
  if (!releases.length) throw new Error('no published releases to list')
  const list = releases.map(renderRelease).join('\n\n')
  return template.replace(PLACEHOLDER, () => list)
}

const [releasesJson, page] = process.argv.slice(2)
const releasePages = JSON.parse(fs.readFileSync(releasesJson, 'utf8'))
fs.writeFileSync(page, renderChangelog(fs.readFileSync(page, 'utf8'), releasePages))
