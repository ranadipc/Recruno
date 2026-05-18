import { NextResponse } from "next/server";
import { deleteWorkflowSnapshot, listWorkflows, loadWorkflowSnapshot, saveWorkflowSnapshot } from "@/lib/store";

export async function GET() {
  return NextResponse.json(await listWorkflows());
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const action = String(body.action ?? "save");
  if (action === "save") {
    return NextResponse.json({ workflows: await saveWorkflowSnapshot(String(body.name ?? "")) });
  }
  if (action === "load") {
    return NextResponse.json({ state: await loadWorkflowSnapshot(String(body.id ?? "")), workflows: await listWorkflows() });
  }
  if (action === "delete") {
    return NextResponse.json({ workflows: await deleteWorkflowSnapshot(String(body.id ?? "")) });
  }
  return NextResponse.json({ error: "Unknown workflow action." }, { status: 400 });
}
