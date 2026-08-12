# Channel Mappings CSV format

The Settings → Routing → Channel Mappings pane has an **Import CSV** and an
**Export CSV** button. Both use the format documented here. See
[`csv-channel-mappings-example.csv`](./csv-channel-mappings-example.csv) for
a concrete file you can copy and edit.

The format is deliberately minimal. Only three columns matter, one of them
optional; the rest are per-option cells.

## File shape

- ASCII CSV with `\r\n` line endings (Windows / operators editing in Excel).
- Optional header row. If present, its cells NAME the columns; if absent,
  columns are read positionally.
- Comment lines beginning with `#` are ignored — the exporter uses these as
  controller block markers so a mixed CSV stays legible.
- Blank lines are ignored.

Every row applies to the controller selected in the Import CSV modal. The
CSV does not carry a controller column — import is scoped by that selector.
Export writes one CSV containing every mapping across every controller,
grouped by controller with a `# {controllerName}` block marker.

## Columns

| Column            | Header alias(es)                       | Required           | Notes                                                                    |
| ----------------- | -------------------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `channel`         | `channel`, `channelNumber`             | Yes                | Integer ≥ 1. Blank / non-numeric rows are skipped with a reason.         |
| `product_code`    | `product`, `productCode`               | Yes                | Non-empty string. Blank rows are skipped with a reason.                  |
| `print_size_code` | `printSizeCode`, `printSize`, `size`   | See below          | Print size for DPOF-family controllers (Noritsu / Epson).                |
| `option`          | any header name that isn't one of the above | No             | Every remaining cell is treated as an option `name:value` pair.          |

Header names are matched case-insensitively and ignore punctuation
(underscores, hyphens, spaces). `Print Size Code`, `printSizeCode`,
`print-size-code` and `printSize` all resolve to the same column.

### When `print_size_code` is required

- **Required** on DPOF-family controllers (Noritsu, Epson). Since v1.7.22
  the IPC save handler rejects a blank `print_size_code` on those controllers,
  and the import summary reports each rejected row with its CSV line number.
- **Optional / ignored** on Fuji JobMaker, Fuji PIC Pro, Darkroom Pro,
  Frontline, folder-copy, and pdf-copy controllers. A populated value is
  saved but not read at dispatch (those controllers derive their print size
  from their own dedicated fields — Fuji `printSize`, Darkroom
  `sizeTranslations`, Frontline `batchCode`, etc.).

### Options

Every column that is not `channel`, `product_code`, or `print_size_code`
is treated as an option cell. Each cell must be shaped `name:value` (a single
colon separator). Cells without a colon are silently dropped so an operator
can add extra notes/description columns without breaking the import.

## Backwards compatibility

CSVs authored before v1.10.1 have no `print_size_code` column. They import
unchanged:

- No header row → strictly positional: `channel`, `product_code`, then
  options at every subsequent column.
- Header row present without `print_size_code` → the parser rewrites
  `channel` and `product_code` by name but leaves the print-size column
  unset. Every DPOF-family row will then be rejected by the IPC validator
  (no print size) and the operator sees a per-row skipped list in the
  import summary.

The exporter emits `print_size_code` from v1.10.1 onward. A CSV exported by
v1.10.1 and imported by v1.10.0 will silently DROP the print-size column
(pre-v1.10.1 parser skips the header and reads positionally). The safer
direction is always to export and import with the same OHD version — the
CSV is not a long-term data interchange format.

## Examples

### Minimal DPOF import (Noritsu)

```csv
channel,product_code,print_size_code
1,PHOTO4X6,KG
2,PHOTO5X7,2L
3,PHOTO8X10,8L
```

### With options

```csv
channel,product_code,print_size_code,option,option
1,PHOTO4X6,KG,finish:lustre,paper:matte
1,PHOTO4X6,KG,finish:glossy,paper:matte
```

Two mappings for the same product, differentiated by option values — the
same `channel` / `product_code` on both is intentional; the option set is
part of the mapping key.

### With extra columns ignored

```csv
channel,product_code,note,print_size_code,option
1,PHOTO4X6,internal reference,KG,finish:lustre
```

The `note` column has no recognised header name; its cell is treated as an
option candidate and, having no `:`, is silently dropped.

### Header-less (pre-v1.10.1)

```csv
1,PHOTO4X6,finish:lustre
2,PHOTO5X7,finish:lustre
```

Still parses. Every row is missing a print size, so on a DPOF-family
controller each row is rejected with a per-row reason.

## Export → import round trip

`Export CSV` writes:

```csv
channel,product_code,print_size_code,option,option
# Noritsu QSS-37
1,PHOTO4X6,KG,finish:lustre,paper:matte
# Fuji PIC Pro
1,PHOTO4X6,,finish:matte,
```

Fuji rows leave `print_size_code` blank (the value lives in the Fuji-
specific `printSize` field which the CSV does not carry). Re-importing into
the same Fuji controller round-trips the channel / product / options
cleanly; the Fuji-specific fields are unaffected because the IPC handler
for Fuji types validates only Fuji-owned fields.

## Rejected-row reporting

The import summary reports:

- Parser-side skips (missing channel, missing product) as
  `Line N: {reason}`.
- IPC-side rejections (validator errors) as
  `Line N (ch X, product Y): {reason}`.

Line numbers are 1-based and count blank / comment lines, so the operator
can jump straight to the offending row in a text editor.
