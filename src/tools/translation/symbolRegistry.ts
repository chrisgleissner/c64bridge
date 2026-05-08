/**
 * In-process symbol registry for VICE debug sessions.
 * Maps addresses to label names so the disassembler can annotate output.
 * Cleared and repopulated each time a new program is loaded.
 */

const viceAddressToLabel = new Map<number, string>();

export function setViceSymbols(nameToAddress: Iterable<readonly [string, number]>): void {
  viceAddressToLabel.clear();
  for (const [name, address] of nameToAddress) {
    if (address >= 0 && address <= 0xffff) {
      viceAddressToLabel.set(address, name);
    }
  }
}

export function getViceSymbol(address: number): string | undefined {
  return viceAddressToLabel.get(address);
}

export function clearViceSymbols(): void {
  viceAddressToLabel.clear();
}

export function getViceSymbols(): ReadonlyMap<number, string> {
  return viceAddressToLabel;
}

/**
 * Parse a VICE symbol file (.vs) into a name->address map.
 *
 * Supported line formats:
 *   add_label 0x0810 .main
 *   add_label C:0810 .main
 *   al C:0810 .main
 *   al 0810 .main
 */
export function parseViceSymbolFile(content: string): Map<string, number> {
  const symbols = new Map<string, number>();
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const match = /^(?:add_label|al)\s+(?:[A-Za-z]+:)?(?:0x|\$)?([0-9A-Fa-f]+)\s+\.?(\S+)/i.exec(line);
    if (match) {
      const addr = parseInt(match[1]!, 16);
      const name = match[2]!;
      if (!isNaN(addr) && addr >= 0 && addr <= 0xffff && name) {
        symbols.set(name, addr);
      }
    }
  }
  return symbols;
}
