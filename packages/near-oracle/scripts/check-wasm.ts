/**
 * Fails when the contract imports anything but NEAR host functions. A compiler
 * without a wasm backend leaves ring's C symbols undefined, the build still
 * succeeds, and the contract then fails to link when first called on chain.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WASM_PATH = fileURLToPath(new URL('../contracts/trigger/res/covantic_trigger.wasm', import.meta.url));
const IMPORT_SECTION = 2;
const FOREIGN_SYMBOL = /^env\.ring_core_|^(?!env\.)/;

function wasmImports(bytes: Buffer): string[] {
  const leb128 = (start: number): [number, number] => {
    let value = 0;
    let shift = 0;
    let at = start;
    for (;;) {
      const byte = bytes[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (byte < 0x80) return [value, at];
    }
  };
  const name = (start: number): [string, number] => {
    const [length, at] = leb128(start);
    return [bytes.toString('utf8', at, at + length), at + length];
  };

  let section = 8;
  while (section < bytes.length) {
    const [size, body] = leb128(section + 1);
    if (bytes[section] === IMPORT_SECTION) {
      const imports: string[] = [];
      let [count, at] = leb128(body);
      for (; count > 0; count -= 1) {
        const [module, afterModule] = name(at);
        const [field, afterField] = name(afterModule);
        imports.push(`${module}.${field}`);
        [, at] = leb128(afterField + 1);
      }
      return imports;
    }
    section = body + size;
  }
  return [];
}

const foreign = wasmImports(readFileSync(WASM_PATH)).filter((item) => FOREIGN_SYMBOL.test(item));
if (foreign.length > 0) {
  process.stderr.write(`contract has ${foreign.length} unresolved imports, e.g. ${foreign[0]}\n`);
  process.exit(1);
}
process.stdout.write('contract imports are all NEAR host functions\n');
