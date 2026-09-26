/**
 * Выход бойца из личного кабинета: снимаем cookie сессии.
 *
 * Запись в журнал входов остаётся — она фиксирует факт входа, а не срок
 * жизни cookie; при необходимости сессию можно отозвать явно (смена пароля).
 */
import { NextResponse } from "next/server";
import { clearMemberCookie, MEMBER_COOKIE } from "@/lib/member-auth";

export const runtime = "nodejs";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  // Удаляем и вспомогательные cookie входа через Discord, если они остались
  response.cookies.delete(MEMBER_COOKIE);
  return clearMemberCookie(response);
}