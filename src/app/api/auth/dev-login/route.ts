/**
 * Быстрый вход для разработки («Dev Login»).
 *
 * Назначение: на локальном стенде боевая база может быть пустой (или её вовсе
 * нет), а проверить кабинет нужно. Роут поднимает трёх подопытных бойцов —
 * командира, танкиста и наводчика — и сразу выдаёт валидную сессию.
 *
 * Почему так, а не «подставить cookie на клиенте»: сессия — подписанный JWT,
 * который сверяется с базой (роль, статус, версия токена). Подделанная cookie
 * не откроет ни /profile, ни роуты: их гварды читают БД. Поэтому вход должен
 * выпускать настоящую сессию, и делает это только сервер.
 *
 * Безопасность: вне NODE_ENV=production роут отвечает 404 — не «403 запрещено»,
 * чтобы не подтверждать существование отладочной ручки на боевом стенде.
 * Решение принимается по окружению процесса, а не по адресу запроса: адрес
 * приходит заголовком Host и подделывается.
 */
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { db } from "@/db";
import { members, users } from "@/db/schema";
import {
  DEV_ACCOUNTS,
  DEV_ADMIN_PASSWORD_DEFAULT,
  DEV_PANEL_USERNAME,
  findDevAccount,
  isDevLoginEnabled,
  type DevAccount,
} from "@/lib/dev-accounts";
import { issuePanelToken, setPanelCookie } from "@/lib/api-auth";
import { issueMemberSession, requestIp, setMemberCookie } from "@/lib/member-auth";
import { checkPasswordPolicy } from "@/lib/password-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Единый ответ «ручки нет»: один и тот же и для боевого стенда, и для мусора */
function notFound(): NextResponse {
  return NextResponse.json({ ok: false, error: "Не найдено" }, { status: 404 });
}

/**
 * Поднимает (или приводит в порядок) запись бойца под dev-вход.
 *
 * Идемпотентно: повторный клик по кнопке не создаёт дубль, а возвращает
 * существующую строку в «в строю». Пароль ставится фиксированный — он же
 * позволяет потом войти обычной формой и проверить её ветки (неверный пароль,
 * блокировку попыток), не выдумывая новый.
 */
async function ensureDevMember(account: DevAccount): Promise<{
  id: number;
  memberTokenVersion: number;
}> {
  const passwordHash = await bcrypt.hash(DEV_ADMIN_PASSWORD_DEFAULT, 10);

  const [row] = await db
    .insert(members)
    .values({
      callsign: account.callsign,
      name: account.name,
      rank: account.rank,
      unit: account.unit,
      post: account.post,
      status: "active",
      active: true,
      role: account.role,
      passwordHash,
    })
    .onConflictDoUpdate({
      target: members.callsign,
      set: {
        name: account.name,
        rank: account.rank,
        unit: account.unit,
        post: account.post,
        status: "active",
        active: true,
        role: account.role,
        passwordHash,
        updatedAt: new Date(),
      },
    })
    .returning({ id: members.id, memberTokenVersion: members.memberTokenVersion });

  return row;
}

/** Учётная запись панели для dev-командира: без неё он не увидит панель */
async function ensureDevPanelUser(memberId: number | null): Promise<{ id: number; tokenVersion: number }> {
  const passwordHash = await bcrypt.hash(DEV_ADMIN_PASSWORD_DEFAULT, 10);

  const [row] = await db
    .insert(users)
    .values({
      username: DEV_PANEL_USERNAME,
      passwordHash,
      role: "admin",
      // Связка с бойцом: одна сессия панели даёт и личный кабинет. Без неё
      // dev-командир после входа упирался в заглушку на /profile (цикл из отчёта).
      memberId,
    })
    .onConflictDoUpdate({
      target: users.username,
      set: { passwordHash, role: "admin", memberId },
    })
    .returning({ id: users.id, tokenVersion: users.tokenVersion });

  return row;
}

/**
 * Список кнопок для формы входа.
 * Отдаётся только когда Dev Login разрешён — страница показывает блок по факту
 * ответа, а не по своей догадке об окружении.
 */
export async function GET(): Promise<NextResponse> {
  if (!isDevLoginEnabled()) return notFound();

  return NextResponse.json({
    ok: true,
    accounts: DEV_ACCOUNTS.map((account) => ({
      key: account.key,
      label: account.label,
      hint: account.hint,
      callsign: account.callsign,
      rank: account.rank,
      unit: account.unit,
    })),
    /** Подсказка разработчику: под каким логином входить в панель вручную */
    panelUsername: DEV_PANEL_USERNAME,
    panelPassword: DEV_ADMIN_PASSWORD_DEFAULT,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isDevLoginEnabled()) return notFound();

  let body: { as?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const account = findDevAccount(body.as);
  if (!account) {
    return NextResponse.json({ ok: false, error: "Неизвестный dev-аккаунт" }, { status: 400 });
  }

  // Пароль обязан проходить политику проекта: иначе дев-вход создал бы бойца,
  // чей пароль панель позже откажется принять при смене.
  const policy = checkPasswordPolicy(DEV_ADMIN_PASSWORD_DEFAULT);
  if (!policy.ok) {
    console.error("[dev-login] Пароль не соответствует политике:", policy.error);
    return NextResponse.json(
      { ok: false, error: "Пароль dev-входа не проходит политику паролей" },
      { status: 500 }
    );
  }

  try {
    const member = await ensureDevMember(account);

    const session = await issueMemberSession(
      {
        id: member.id,
        callsign: account.callsign,
        role: account.role,
        memberTokenVersion: member.memberTokenVersion,
      },
      "password",
      { ip: requestIp(req) }
    );

    // Командиру выдаём и сессию панели: по ТЗ он должен попадать и в панель,
    // и в личный кабинет. Обе cookie живут одновременно (гибридная схема).
    let panelToken: string | null = null;
    if (account.panelRole) {
      const panelUser = await ensureDevPanelUser(member.id);
      panelToken = await issuePanelToken({
        id: panelUser.id,
        username: DEV_PANEL_USERNAME,
        role: account.panelRole,
        tokenVersion: panelUser.tokenVersion,
      });
    }

    const response = NextResponse.json({
      ok: true,
      callsign: account.callsign,
      redirectTo: "/profile",
      hasPanel: Boolean(panelToken),
    });

    setMemberCookie(response, session, req);
    if (panelToken) setPanelCookie(response, panelToken, req);

    return response;
  } catch (e) {
    console.error("[dev-login] Не удалось выдать сессию:", e);
    return NextResponse.json(
      { ok: false, error: "База данных недоступна — dev-вход не выполнен" },
      { status: 500 }
    );
  }
}