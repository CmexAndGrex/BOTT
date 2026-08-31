import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET || "temp-secret-key");

const protectedPaths = [
  "/settings", "/logs", "/users",
  "/api/actions", "/api/sync", "/api/logs", 
  "/api/extension.zip", "/api/users"
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isProtected = protectedPaths.some(p => pathname.startsWith(p));

  if (!isProtected) return NextResponse.next();

  const token = req.cookies.get("auth_token")?.value;
  if (!token) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Нет доступа" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    const verified = await jwtVerify(token, SECRET);
    const role = (verified.payload as any).role;

    if ((pathname.startsWith("/settings") || pathname.startsWith("/users")) && role !== "admin") {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  } catch (e) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Сессия устарела" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }
}