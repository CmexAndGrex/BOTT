/**
 * Старт входа через Discord OAuth2 — основной (быстрый) способ.
 *
 * Роут отдаёт JSON со ссылкой на согласие в Discord, а не редиректит сам:
 * страница входа сначала запрашивает ссылку, поэтому ошибка конфигурации
 * показывается прямо в интерфейсе, а не как пустая страница Discord.
 *
 * Намерение передаётся в GET: login — обычный вход (после callback боец
 * попадает в кабинет) или link — привязка Discord к уже созданному аккаунту
 * (возврат в кабинет с сохранением контакта). Намерение вшивается в
 * подписанный state, поэтому подменить его на клиенте нельзя.
 */
import { NextRequest, NextResponse } from "next/server";
import { isSecureRequest } from "@/lib/api-auth";
import {
  createOAuthState,
  discordAuthorizeUrl,
  discordOAuthConfig,
  discordRedirectUri,
  getSessionMember,
  MEMBER_OAUTH_LINK_COOKIE,
  MEMBER_OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_SECONDS,
} from "@/lib/member-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const config = discordOAuthConfig();
  if (!config) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Вход через Discord не настроен: заполните DISCORD_CLIENT_ID и DISCORD_CLIENT_SECRET в .env",
      },
      { status: 503 }
    );
  }

  const intent = req.nextUrl.searchParams.get("intent") === "link" ? "link" : "login";

  // Для привязки сначала убеждаемся, что есть своя сессия: Discord нужно
  // привязать к конкретному аккаунту, а не к тому, что подставит клиент.
  let linkMemberId: number | null = null;
  if (intent === "link") {
    const member = await getSessionMember(req);
    if (!member) {
      return NextResponse.json(
        { ok: false, error: "Сначала войдите в личный кабинет, затем привяжите Discord" },
        { status: 401 }
      );
    }
    linkMemberId = member.id;
  }

  const state = await createOAuthState(intent);
  const secure = isSecureRequest(req);
  const response = NextResponse.json({
    ok: true,
    intent,
    url: discordAuthorizeUrl(config.clientId, discordRedirectUri(req), state),
  });

  // sameSite=lax: cookie должна уйти вместе с редиректом возврата
  // (Discord возвращает браузер GET-запросом с нашего домена).
  response.cookies.set({
    name: MEMBER_OAUTH_STATE_COOKIE,
    value: state,
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });
  if (linkMemberId !== null) {
    response.cookies.set({
      name: MEMBER_OAUTH_LINK_COOKIE,
      value: String(linkMemberId),
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure,
      maxAge: OAUTH_STATE_TTL_SECONDS,
    });
  }

  return response;
}