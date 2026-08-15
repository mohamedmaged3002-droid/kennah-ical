#!/usr/bin/env python3
"""out/changes.json -> out/kennah-price-changes.xlsx (changed units only)."""
import json, pathlib
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

ROOT = pathlib.Path(__file__).parent
src = ROOT / "out" / "changes.json"
if not src.exists():
    print("no changes.json — nothing to build"); raise SystemExit(0)
d = json.loads(src.read_text())
if not d.get("changed") and not d.get("added") and not d.get("removed"):
    print("no changes — no sheet"); raise SystemExit(0)

wb = Workbook(); ws = wb.active; ws.title = "Price changes"
hdr = ["wp_post_id", "unit", "date", "old USD", "new USD", "change USD", "direction"]
ws.append(hdr)
for c in range(1, len(hdr) + 1):
    ws.cell(1, c).font = Font(bold=True, color="FFFFFF")
    ws.cell(1, c).fill = PatternFill("solid", fgColor="1F4E79")

up = PatternFill("solid", fgColor="FCE4D6")
down = PatternFill("solid", fgColor="E2EFDA")
for u in d.get("changed", []):
    for n in u["nights"]:
        delta = n["to"] - n["from"]
        ws.append([u["wp"], u["name"], n["date"], n["from"], n["to"], delta,
                   "increase" if delta > 0 else "decrease"])
        for c in range(1, len(hdr) + 1):
            ws.cell(ws.max_row, c).fill = up if delta > 0 else down

for i, w in enumerate([12, 44, 12, 10, 10, 12, 11], start=1):
    ws.column_dimensions[get_column_letter(i)].width = w
ws.freeze_panes = "A2"
ws.auto_filter.ref = f"A1:{get_column_letter(len(hdr))}{ws.max_row}"

if d.get("added") or d.get("removed"):
    r = wb.create_sheet("Roster")
    r.append(["change", "wp_post_id"])
    r.cell(1, 1).font = Font(bold=True); r.cell(1, 2).font = Font(bold=True)
    for wp in d.get("added", []): r.append(["NEW on kennahstays.com", wp])
    for wp in d.get("removed", []): r.append(["GONE from kennahstays.com", wp])
    r.column_dimensions["A"].width = 30; r.column_dimensions["B"].width = 14

out = ROOT / "out" / "kennah-price-changes.xlsx"
wb.save(out)
print(f"wrote {out} ({ws.max_row - 1} changed nights)")
