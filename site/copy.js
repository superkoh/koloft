document.querySelectorAll('button[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    const text = document.getElementById(button.dataset.copy).textContent.trim()
    await navigator.clipboard.writeText(text)
    button.textContent = 'Copied'
    setTimeout(() => (button.textContent = 'Copy'), 1500)
  })
})
