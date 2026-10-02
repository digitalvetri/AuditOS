import { Writable } from 'node:stream'

/**
 * Run a PDF writer that expects an Express Response and collect its bytes.
 * The writers only pipe into the response and set headers.
 */
export async function renderPdf(write: (res: never) => unknown): Promise<Buffer> {
  const chunks: Buffer[] = []
  const sink = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb() } }) as Writable & { setHeader: () => void }
  sink.setHeader = () => undefined
  const done = new Promise<void>((resolve, reject) => { sink.on('finish', resolve); sink.on('error', reject) })
  await write(sink as never)
  await done
  return Buffer.concat(chunks)
}
