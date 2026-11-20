# BASIC Pitfalls Quickref

Common mistakes and gotchas when writing Commodore BASIC v2 programs.

## Quotation Handling

**Problem:** Strings with unmatched quotes cause parsing errors.

```basic
10 PRINT "HELLO WORLD
```

**Solution:** Always close string literals with matching double quotes.

```basic
10 PRINT "HELLO WORLD"
```

**Escaping quotes:** BASIC v2 has no escape sequence. Use `CHR$(34)` for embedded quotes.

```basic
10 PRINT "HE SAID " + CHR$(34) + "HELLO" + CHR$(34)
```

## Line Length Limits

**Problem:** BASIC lines are limited to 80 characters (2 physical screen lines). Longer lines are truncated or cause errors.

**Solution:** Break long statements across multiple numbered lines.

```basic
10 A=1:B=2:C=3
20 D=A+B+C
```

**Multi-statement lines:** Use `:` to separate statements, but watch total character count.

## Line Numbers

**Problem:** Line numbers must be 0-63999. Reordering requires renumbering.

**Best practice:** Use increments of 10 (e.g., 10, 20, 30) to leave room for insertions.

```basic
10 REM MAIN LOOP
20 FOR I=1 TO 10
30 PRINT I
40 NEXT I
```

## Tokenization Issues

**Problem:** BASIC tokenizes keywords in program lines, which affects string matching.

**DATA is not affected:** the tokenizer leaves the rest of a `DATA` statement untokenized, so keywords in `DATA` read back as text.

```basic
10 DATA PRINT,GOTO,END
20 READ A$,B$,C$
30 PRINT A$  :REM DISPLAYS "PRINT"
```

## Variable Names

**Problem:** Only the first two characters are significant. `SPEED` and `SPECIAL` both resolve to `SP`.

```basic
10 SPEED=10
20 SPECIAL=20
30 PRINT SPEED  :REM PRINTS 20, NOT 10
```

**Solution:** Use unique first-two-character combinations.

```basic
10 SP=10
20 SZ=20
```

## Array Dimensions

**Problem:** Arrays default to dimension 10 (indices 0-10, 11 elements). Using `DIM A(10)` also creates 11 elements (0-10).

**Solution:** Explicitly dimension arrays to the exact size needed and remember the 0 index.

```basic
10 DIM A(9)  :REM CREATES 10 ELEMENTS (0-9)
20 FOR I=0 TO 9
30 A(I)=I*2
40 NEXT I
```

## String Concatenation

**Problem:** String concatenation without spaces can be ambiguous.

```basic
10 A$="HELLO"
20 B$="WORLD"
30 C$=A$+B$  :REM WORKS
40 D$=A$B$   :REM SYNTAX ERROR
```

**Solution:** Always use `+` for concatenation.

## Floating Point Precision

**Problem:** BASIC uses 5-byte floating point with limited precision (~9 digits). Rounding errors accumulate.

```basic
10 A=0.1+0.1+0.1
20 PRINT A=0.3  :REM MAY PRINT 0 (FALSE)
```

**Solution:** Use integer arithmetic when exact values are required, or add small epsilon for comparisons.

```basic
10 A=1+1+1
20 B=A/10
30 IF ABS(B-0.3)<0.0001 THEN PRINT "CLOSE ENOUGH"
```

## Device Numbers

**Problem:** Using wrong device numbers causes `FILE NOT FOUND` or hangs.

- Device 0: Keyboard
- Device 1: Cassette
- Device 3: Screen
- Device 4-7: Printers
- Device 8-11: Disk drives

**Solution:** Always verify device numbers before `OPEN` statements.

```basic
10 OPEN 1,8,15,"I0":REM OPEN COMMAND CHANNEL ON DRIVE 8
```

## Memory Conflicts

**Problem:** BASIC program area grows downward from `$0801`. String/array space grows upward from `$9FFF` (or lower if adjusted). They can collide.

**Symptoms:** `OUT OF MEMORY` errors or system crashes.

**Solution:** Monitor free memory with `FRE(0)` and keep programs compact.

```basic
10 PRINT FRE(0)  :REM PRINT FREE BYTES
```

## GOTO/GOSUB Loops

**Problem:** Excessive `GOSUB` without matching `RETURN` exhausts the stack (limited to ~50 nested calls).

**Solution:** Structure programs with main loops and balanced subroutine calls.

```basic
10 FOR I=1 TO 10
20 GOSUB 100
30 NEXT I
40 END
100 PRINT I
110 RETURN
```

## Timing and Speed

**Problem:** BASIC is interpreted and slow (~1000 statements/sec). Tight loops with many operations lag.

**Solution:** Optimize hot loops, minimize array access, and consider assembly for performance-critical code.

```basic
10 REM SLOW
20 FOR I=1 TO 1000
30 A=A+1:B=B+1:C=C+1
40 NEXT I

10 REM FASTER
20 FOR I=1 TO 1000
30 A=A+1
40 NEXT I:B=A:C=A
```

## Input Quirks

**Problem:** `INPUT` statements can be aborted with `STOP` or `RUN/STOP-RESTORE`, leaving variables unchanged or partially set.

**Solution:** Validate inputs and handle empty/invalid responses.

```basic
10 INPUT "ENTER NUMBER";A
20 IF A<1 OR A>100 THEN PRINT "INVALID":GOTO 10
```

## Screen Codes vs. PETSCII

**Problem:** `PRINT` uses PETSCII codes, but `POKE` to screen memory requires screen codes (different mappings).

**Solution:** Use conversion routines or lookup tables when directly writing to screen RAM ($0400-$07E7).

```basic
10 REM PRINT USES PETSCII
20 PRINT "A"  :REM DISPLAYS 'A'

30 REM POKE TO SCREEN USES SCREEN CODES
40 POKE 1024,1  :REM DISPLAYS 'A' (SCREEN CODE 1)
```

## RESTORE Statement

**Problem:** `RESTORE` without line number resets `READ` pointer to the first `DATA` statement. If you need to re-read from a specific line, use `RESTORE linenum`.

```basic
10 DATA 1,2,3
20 DATA 4,5,6
30 READ A:READ B:READ C
40 RESTORE 20  :REM RESET TO LINE 20
50 READ D:READ E:READ F
```

## Summary

- **Always close quotes** and watch line lengths (80 chars).
- **Use unique variable prefixes** (first 2 chars matter).
- **Dimension arrays explicitly** and remember 0-indexing.
- **DATA contents are not tokenized**; keywords in DATA read back as text.
- **Check device numbers** before OPEN.
- **Balance GOSUB/RETURN** to avoid stack overflow.
- **Validate INPUT** to handle user errors gracefully.
- **Convert between PETSCII and screen codes** when needed.
