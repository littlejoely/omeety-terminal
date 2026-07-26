if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.error('KEYPROBE_ERROR:not-a-tty')
  process.exit(2)
}

process.stdin.setRawMode(true)
process.stdin.resume()
console.log('KEYPROBE_READY')

let count = 0
process.stdin.on('data', (chunk) => {
  console.log(`KEYHEX:${Buffer.from(chunk).toString('hex')}`)
  count++
  if (count >= 2) {
    process.stdin.setRawMode(false)
    process.exit(0)
  }
})
