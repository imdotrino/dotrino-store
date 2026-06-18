// Servidor estático mínimo para los tests: sirve el vault `store/` por HTTP
// (los módulos ES del iframe necesitan http, no file://).
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = fileURLToPath(new URL('../store/', import.meta.url))
const port = Number(process.env.PORT) || 8137
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url || '/').split('?')[0])
    if (path === '/') path = '/index.html'
    const file = join(root, normalize(path))
    if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return }
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404); res.end('not found')
  }
}).listen(port, () => console.log('[test] store served on http://localhost:' + port))
