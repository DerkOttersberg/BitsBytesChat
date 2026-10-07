---
name: bb-spreadsheets
description: "Create, inspect and edit Excel workbooks and CSV data, including formulas and formatted tables."
---

# spreadsheets

Use openpyxl for XLSX formatting, formulas, tables, charts and precise template edits; pandas for data transformation. create_artifact accepts filename.xlsx and sheets [{name,rows}]. Keep values numeric; use formulas for derived values. openpyxl does not calculate formulas. The app uses installed Excel to recalculate a separate preview cache and reports formula errors. Compare expected totals and sample formula results; inspect grid and rendered pages. Never claim cached values were recalculated without a successful Excel result. Preserve styles and formulas when editing existing workbooks.

Read [desktop-tools.md](references/desktop-tools.md) for the local creation, inspection and publication workflow.
