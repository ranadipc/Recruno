import { NextResponse } from "next/server";
import { getSettings, saveSettings, toPublicSettings } from "@/lib/store";

export async function GET() {
  const settings = await getSettings();
  return NextResponse.json(toPublicSettings(settings));
}

export async function POST(request: Request) {
  const body = await request.json();
  const settings = await saveSettings(body);
  return NextResponse.json(toPublicSettings(settings));
}
