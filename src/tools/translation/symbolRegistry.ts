/**
 * In-process symbol registry for VICE debug sessions.
 * Maps addresses to label names so the disassembler can annotate output.
 * Cleared and repopulated each time a new program is loaded.
 */

const viceAddressToLabel = new Map<number, string>();
// Every registered name, including several names for one address (the address
// map keeps only the last one). A repeated name keeps its last address.
const viceNameToAddress = new Map<string, number>();

export function setViceSymbols(nameToAddress: Iterable<readonly [string, number]>): void {
  viceAddressToLabel.clear();
  viceNameToAddress.clear();
  for (const [name, address] of nameToAddress) {
    if (address >= 0 && address <= 0xffff) {
      viceAddressToLabel.set(address, name);
      viceNameToAddress.set(name, address);
    }
  }
}

export function getViceSymbol(address: number): string | undefined {
  return viceAddressToLabel.get(address);
}

export function getSymbolAddress(name: string): number | undefined {
  return viceNameToAddress.get(name);
}

export function clearViceSymbols(): void {
  viceAddressToLabel.clear();
  viceNameToAddress.clear();
}

export function getViceSymbols(): ReadonlyMap<number, string> {
  return viceAddressToLabel;
}

/** Formats accepted by parseSymbolFile, for warnings and descriptions. */
export const SYMBOL_FILE_FORMATS = "VICE 'al C:0810 .name', 64tass/ACME 'name = $0810', KickAssembler '.label name=$0810'";

function parseAssignedAddress(text: string): number | undefined {
  // Hex needs a $ or 0x prefix; bare digits are decimal, as 64tass and ACME emit them.
  const hexMatch = /^(?:\$|0x)([0-9A-Fa-f]+)$/i.exec(text);
  if (hexMatch) return parseInt(hexMatch[1]!, 16);
  if (/^[0-9]+$/.test(text)) return parseInt(text, 10);
  return undefined;
}

/**
 * Parse a symbol/label file into a name->address map.
 *
 * Supported line formats (unrecognised lines are ignored):
 *   VICE:         al C:0810 .main | add_label 0x0810 .main (bare digits are hex)
 *   64tass, ACME: main = $0810 | main = 2064 (bare digits are decimal)
 *   KickAssembler: .label main=$0810 (.namespace lines and braces are ignored)
 */
export function parseSymbolFile(content: string): Map<string, number> {
  const symbols = new Map<string, number>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#") || line.startsWith("//")) continue;
    let name: string | undefined;
    let addr: number | undefined;
    const vice = /^(?:add_label|al)\s+(?:[A-Za-z]+:)?(?:0x|\$)?([0-9A-Fa-f]+)\s+\.?(\S+)/i.exec(line);
    if (vice) {
      addr = parseInt(vice[1]!, 16);
      name = vice[2]!;
    } else {
      const assigned = /^(?:\.label\s+)?([A-Za-z_.][\w.]*)\s*=\s*(\S+?)\s*(?:[;].*)?$/.exec(line);
      if (assigned) {
        name = assigned[1]!;
        addr = parseAssignedAddress(assigned[2]!);
      }
    }
    if (name && addr !== undefined && !isNaN(addr) && addr >= 0 && addr <= 0xffff) {
      symbols.set(name, addr);
    }
  }
  return symbols;
}

export const parseViceSymbolFile = parseSymbolFile;
