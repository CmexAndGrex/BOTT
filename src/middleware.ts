import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { getJwtSecret } from "@/lib/auth";

const SECRET = getJwtSecret();

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

    const isAdminArea =
      pathname.startsWith("/settings") ||
      pathname.startsWith("/users") ||
      pathname.startsWith("/api/extension.zip");

    if (isAdminArea && role !== "admin") {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Только для администратора" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  } catch (e) {
    if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Сессия устарела" }, { status: 401 });
    return NextResponse.redirect(new URL("/login", req.url));
  }
}
