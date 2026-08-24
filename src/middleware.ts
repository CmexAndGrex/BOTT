import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SECRET = new TextEncoder().encode(process.env.POSTGRES_PASSWORD || "super-secret");

// Список путей, куда нужен логин
const protectedPaths = ["/settings", "/logs", "/api/actions", "/api/sync"];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isProtected = protectedPaths.some(p => pathname.startsWith(p));

  if (!isProtected) {
    return NextResponse.next();
  }

  const token = req.cookies.get("auth_token")?.value;
  if (!token) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  try {
    const verified = await jwtVerify(token, SECRET);
    const role = (verified.payload as any).role;

    // Только админ может заходить в настройки
    if (pathname.startsWith("/settings") && role !== "admin") {
      return NextResponse.redirect(new URL("/", req.url));
    }

    return NextResponse.next();
  } catch (e) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
}