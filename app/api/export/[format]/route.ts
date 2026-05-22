import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { getState } from "@/lib/store";
import { csvEscape, recruiterRows } from "@/lib/sheet";

function rowsFromState(includeRejected: boolean) {
  return getState().then((state) => recruiterRows(state.candidates, { includeRejected }));
}

export async function GET(request: Request, context: { params: Promise<{ format: string }> }) {
  const { format } = await context.params;
  const includeRejected = new URL(request.url).searchParams.get("includeRejected") === "1";
  const rows = await rowsFromState(includeRejected);
  if (format === "json") {
    return new NextResponse(JSON.stringify(rows, null, 2), {
      headers: { "Content-Type": "application/json", "Content-Disposition": "attachment; filename=recruno-final-sheet.json" }
    });
  }
  if (format === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Candidates");
    worksheet.columns = Object.keys(rows[0] ?? { "Candidate Name": "" }).map((header) => ({
      header,
      key: header,
      width: Math.min(50, Math.max(16, header.length + 4))
    }));
    rows.forEach((row) => worksheet.addRow(row));
    worksheet.getRow(1).font = { bold: true };
    const buffer = await workbook.xlsx.writeBuffer();
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": "attachment; filename=recruno-final-sheet.xlsx"
      }
    });
  }
  const headers = Object.keys(rows[0] ?? { "Candidate Name": "" });
  const csv = [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header as keyof typeof row])).join(","))].join("\n");
  return new NextResponse(csv, {
    headers: { "Content-Type": "text/csv", "Content-Disposition": "attachment; filename=recruno-final-sheet.csv" }
  });
}
