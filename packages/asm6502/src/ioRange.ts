// The I/O area of the C64 memory map. Memory access here reaches device registers, not RAM.
export const IO_RANGE_START = 0xD000;
export const IO_RANGE_END = 0xDFFF;

/** True when the `length` bytes starting at `start` overlap $D000-$DFFF. A length of 0 or less overlaps nothing. */
export function rangeOverlapsIo(start: number, length: number): boolean {
  if (!(length > 0)) return false;
  return start <= IO_RANGE_END && start + length - 1 >= IO_RANGE_START;
}
