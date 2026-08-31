import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");

export async function GET(req: NextRequest) {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return NextResponse.json({ role: "guest" });

  try {
    const verified = await jwtVerify(token, SECRET);
    return NextResponse.json({ 
      ok: true, 
      role: (verified.payload as any).role || "guest",
      username: (verified.payload as any).username 
    });
  } catch {
    return NextResponse.json({ role: "guest" });
  }
}