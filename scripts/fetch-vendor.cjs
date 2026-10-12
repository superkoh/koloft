const fetchGh = require('./fetch-gh.cjs').default
const fetchGit = require('./fetch-git.cjs').default

async function fetchVendor() {
  await fetchGh()
  await fetchGit()
}

exports.default = fetchVendor

if (require.main === module) {
  fetchVendor().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
