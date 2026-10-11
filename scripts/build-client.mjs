// Bundles the browser half into dist/client.js.
//
// The browser module table only answers `react` (through the factory's
// `require`), so every other dependency - zod - must be inlined into the
// artifact. tsc already type-checked this file and emitted its own
// dist/client.js; this bundle intentionally replaces that output.
import { rolldown } from 'rolldown'

const bundle = await rolldown({
  input: 'src/client.ts',
  platform: 'browser',
  external: [],
})
const written = await bundle.write({ file: 'dist/client.js', format: 'esm', sourcemap: false })
await bundle.close()
console.log(`client bundle: ${written.output.length} chunk(s) -> dist/client.js`)
