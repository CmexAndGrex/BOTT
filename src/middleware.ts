import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

const SECRET = new TextEncoder().encode(process.env.POSTGRES_PASSWORD || "super-secret");

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/cookie') ||
    pathname.startsWith('/api/extension.zip') ||
    pathname.startsWith('/api/health') ||
    pathname.includes('.')
  ) {
    return NextResponse.next();
  }

  const token = req.cookies.get('auth_token')?.value;

  if (!token) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  try {
    const verified = await jwtVerify(token, SECRET);
    const role = verified.payload.role as string;

    // Блокируем офицерам доступ в настройки
    if (pathname.startsWith('/settings') && role !== 'admin') {
      return NextResponse.redirect(new URL('/', req.url));
    }

    // Сообщаем браузеру роль пользователя, чтобы скрыть нужные кнопки
    const response = NextResponse.next();
    response.cookies.set('user_role', role, { path: '/' });
    return response;
  } catch (error) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};