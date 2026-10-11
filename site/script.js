for (const button of document.querySelectorAll('.copy')) {
  const label = button.textContent
  button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(document.getElementById(button.dataset.copy).textContent)
    button.textContent = 'Copied'
    setTimeout(() => (button.textContent = label), 1500)
  })
}

for (const table of document.querySelectorAll('.typed-table table')) {
  const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim())
  for (const row of table.querySelectorAll('tbody tr')) {
    for (const [i, cell] of [...row.cells].entries()) {
      if (heads[i]) cell.dataset.label = heads[i]
    }
  }
}
