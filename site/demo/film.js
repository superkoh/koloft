let filmDoc = ''
let filmDocAt = -1

function applyHunks(doc, hunks) {
  for (let i = hunks.length - 1; i >= 0; i--) {
    const [at, cut, text] = hunks[i]
    doc = doc.slice(0, at) + text + doc.slice(at + cut)
  }
  return doc
}

function decode(frames, n) {
  if (n < filmDocAt) {
    filmDoc = ''
    filmDocAt = -1
  }
  while (filmDocAt < n) filmDoc = applyHunks(filmDoc, frames[++filmDocAt].d)
  const [root, portals] = filmDoc.split('\u0001')
  return { root, portals: portals ? portals.split('\u0002') : [] }
}
