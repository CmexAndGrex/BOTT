import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.POSTGRES_PASSWORD || "super-secret");

export async function GET(req: NextRequest) {
  const token = req.cookies.get("auth_token")?.value;
  if (!token) return NextResponse.json({ role: "guest" });

  try {
    const verified = await jwtVerify(token, SECRET);
    return NextResponse.json({ role: (verified.payload as any).role || "officer" });
  } catch {
    return NextResponse.json({ role: "guest" });
  }
}