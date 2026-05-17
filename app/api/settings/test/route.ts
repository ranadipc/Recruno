import { NextResponse } from "next/server";
import { testProvider } from "@/lib/external";
import { getSettings } from "@/lib/store";

export async function POST(request: Request) {
  try {
    const { provider } = await request.json();
    const settings = await getSettings();
    const result = await testProvider(settings, provider);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ ok: false, message: error instanceof Error ? error.message : "Provider test failed." }, { status: 400 });
  }
}
