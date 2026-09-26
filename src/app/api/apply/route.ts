/**
 * Подача рапорта на вступление (страница /apply).
 *
 * Создаёт бойца со статусом pending: доступ в кабинет закрыт до одобрения
 * штабом. Пароль хешируется bcryptjs — он нужен для резервного входа, если с
 * Discord возникнут проблемы.
 *
 * Discord ID берётся ТОЛЬКО из httpOnly-cookie, которую поставил callback
 * Discord (её нельзя подделать с клиента). Ручной ввод допускается как
 * отдельная ветка: кандидат без Discord указывает ID текстом, а модератор
 * проверяет его при рассмотрении. Доверять полю из формы напрямую нельзя —
 * иначе можно было бы «занять» чужой Discord ID и получить чужой аккаунт.
 */
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { logs, members, recruitApplications } from "@/db/schema";
import { checkPasswordPolicy } from "@/lib/password-policy";
import { MEMBER_OAUTH_PENDING_COOKIE, requestIp, unpackDiscordProfile } from "@/lib/member-auth";
import { buildRecruitEmbed } from "@/lib/reports";
import { publishReviewMessage, recruitsChannelId } from "@/lib/review";
import {
  DEFAULT_RANK,
  isCallsign,
  isDiscordSnowflake,
  LoginThrottle,
  MANUAL_DISCORD_ID,
  normalizeCallsign,
  PENDING_NOTICE,
  readApplication,
  validateApplication,
} from "@/lib/recruits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Ограничитель подачи рапортов: защита от массового создания аккаунтов.
 *
 * Считаем только «настоящие» попытки злоупотребления — успешно созданный рапорт
 * и попытку занять чужой позывной/Discord. Ошибки ввода (короткий пароль,
 * возраст, пустой опыт) в лимит НЕ идут: иначе боец, трижды опечатавшийся в
 * форме, получал бы блокировку на полчаса вместо подсказки об ошибке.
 */
const throttle = new LoginThrottle(5, 30 * 60 * 1000);

type ApplyBody = {
  callsign?: unknown;
  password?: unknown;
  age?: unknown;
  armaExperience?: unknown;
  specialization?: unknown;
  comment?: unknown;
  discordId?: unknown;
  /** Логин или глобальное имя в Discord: заполняется вручную, если нет OAuth-контакта */
  discordTag?: unknown;
};

/**
 * Черновик формы: подтягивает контакт Discord, если кандидат только что вошёл
 * через Discord и ещё не зачислен. Форма заполняет поле автоматически.
 */
export async function GET(req: NextRequest) {
  const fromCookie = unpackDiscordProfile(req.cookies.get(MEMBER_OAUTH_PENDING_COOKIE)?.value);
  return NextResponse.json({
    ok: true,
    discord: fromCookie ? { id: fromCookie.id, avatarUrl: fromCookie.avatarUrl } : null,
    manualMarker: MANUAL_DISCORD_ID,
  });
}

export async function POST(req: NextRequest) {
  const ip = requestIp(req);

  let body: ApplyBody;
  try {
    body = (await req.json()) as ApplyBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const state = throttle.check(ip);
  if (state.locked) {
    return NextResponse.json(
      {
        ok: false,
        error: `Слишком много рапортов с одного адреса. Повторите через ${state.retryAfterMinutes} мин.`,
      },
      { status: 429 }
    );
  }

  const callsign = normalizeCallsign(body.callsign);
  if (!isCallsign(callsign)) {
    return NextResponse.json(
      { ok: false, error: "Позывной: 3–32 символа — буквы, цифры, пробел, точка, дефис" },
      { status: 400 }
    );
  }

  const policy = checkPasswordPolicy(body.password);
  if (!policy.ok) {
    return NextResponse.json({ ok: false, error: policy.error }, { status: 400 });
  }

  const application = validateApplication({
    age: body.age,
    armaExperience: body.armaExperience,
    specialization: body.specialization,
    comment: body.comment,
  });
  if (!application.ok) {
    return NextResponse.json({ ok: false, error: application.error }, { status: 400 });
  }

  return createRecruit(req, ip, {
    callsign,
    password: String(body.password),
    discordIdRaw: typeof body.discordId === "string" ? body.discordId : "",
    discordTag: typeof body.discordTag === "string" ? body.discordTag : "",
    data: application.data,
  });
}
/**
 * Создание бойца со статусом pending.
 * Вынесено отдельно, чтобы основной обработчик читался как последовательность
 * проверок, а не как «простыня» с вставкой в БД.
 */
async function createRecruit(
  req: NextRequest,
  ip: string,
  input: {
    callsign: string;
    password: string;
    discordIdRaw: string;
    discordTag: string;
    data: { age: number; armaExperience: string; specialization: string; comment: string };
  }
): Promise<NextResponse> {
  // Контакт Discord: из cookie (доверенный) либо ручной ввод из формы
  const fromCookie = unpackDiscordProfile(req.cookies.get(MEMBER_OAUTH_PENDING_COOKIE)?.value);
  const manualRaw = input.discordIdRaw.replace(/\D/g, "");
  const manualId = manualRaw && isDiscordSnowflake(manualRaw) ? manualRaw : null;
  if (input.discordIdRaw.trim() && !manualId && !fromCookie) {
    return NextResponse.json(
      { ok: false, error: "Discord ID: ожидается числовой ID (только цифры) или пустое поле" },
      { status: 400 }
    );
  }
  const discordId = fromCookie?.id ?? manualId;

  try {
    // Позывной — это логин, поэтому он должен быть свободен
    const [existing] = await db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.callsign, input.callsign));
    if (existing) {
      throttle.registerFailure(ip);
      return NextResponse.json(
        { ok: false, error: `Позывной «${input.callsign}» уже занят — выберите другой` },
        { status: 409 }
      );
    }

    // Один Discord не может стоять у двух аккаунтов
    if (discordId) {
      const [taken] = await db
        .select({ id: members.id })
        .from(members)
        .where(eq(members.discordId, discordId));
      if (taken) {
        throttle.registerFailure(ip);
        return NextResponse.json(
          {
            ok: false,
            error: "Этот Discord уже привязан к другому аккаунту: войдите через Discord",
          },
          { status: 409 }
        );
      }
    }

    const passwordHash = await bcrypt.hash(input.password, 10);

    const [created] = await db
      .insert(members)
      .values({
        // name — имя бойца для табеля ШДС; при одобрении модератор может уточнить
        name: input.callsign,
        callsign: input.callsign,
        passwordHash,
        rank: DEFAULT_RANK,
        // Подразделение назначает модератор: от него зависит лист Google Таблицы
        unit: null,
        status: "pending",
        role: "recruit",
        discordId,
        avatarUrl: fromCookie?.avatarUrl ?? null,
        applicationData: {
          ...input.data,
          source: fromCookie ? "discord" : "password",
        },
      })
      .returning({ id: members.id, callsign: members.callsign });

    if (!created) {
      return NextResponse.json({ ok: false, error: "Не удалось создать рапорт" }, { status: 500 });
    }

    // Заявка дублируется в отдельную таблицу: именно её показывает канал
    // Discord с кнопками, и по ней принимается решение. Карточка бойца —
    // следствие решения, а не сама заявка.
    const [applicationRow] = await db
      .insert(recruitApplications)
      .values({
        memberId: created.id,
        callsign: created.callsign || input.callsign,
        discordTag: input.discordTag.trim().slice(0, 64) || fromCookie?.username || "",
        discordId,
        age: input.data.age,
        armaExperience: input.data.armaExperience,
        about: [input.data.specialization, input.data.comment].filter(Boolean).join(" · "),
        status: "pending",
      })
      .returning();

    // Публикация в штабном канале: ошибка Discord не отменяет заявку —
    // она уже в БД и доступна в панели модерации
    if (applicationRow) {
      const channelId = await recruitsChannelId();
      const published = await publishReviewMessage(
        channelId,
        "recruit",
        applicationRow.id,
        buildRecruitEmbed({
          id: applicationRow.id,
          callsign: applicationRow.callsign,
          discordTag: applicationRow.discordTag || "",
          discordId: applicationRow.discordId,
          age: applicationRow.age,
          armaExperience: applicationRow.armaExperience || "",
          about: applicationRow.about || "",
          createdAt: applicationRow.createdAt,
          status: "pending",
        })
      );

      if (published.ok) {
        await db
          .update(recruitApplications)
          .set({ discordMessageId: published.messageId, discordChannelId: published.channelId })
          .where(eq(recruitApplications.id, applicationRow.id));
      } else {
        console.warn(`[apply] Заявка #${applicationRow.id} не опубликована: ${published.error}`);
      }
    }

    // Успешное создание рапорта засчитываем в лимит: защита от массового
    // создания аккаунтов (ошибки ввода выше в лимит не идут)
    throttle.registerFailure(ip);

    await db.insert(logs).values({
      category: "edit",
      author: input.callsign,
      action: "подал рапорт на вступление",
      details: {
        "Позывной": input.callsign,
        "Возраст": String(input.data.age),
        "Специализация": input.data.specialization,
        "Discord": discordId || "не указан",
        "Источник": fromCookie ? "вход через Discord" : "ручной ввод",
      },
      kind: "system",
      title: "Новый рапорт",
      detail: `Рапорт от ${input.callsign} ожидает рассмотрения штаба`,
      ok: true,
    });

    const response = NextResponse.json({
      ok: true,
      status: "pending",
      message: PENDING_NOTICE,
      callsign: created.callsign,
      application: readApplication(input.data),
    });
    // Контакт Discord больше не нужен: он сохранён в анкете
    response.cookies.delete(MEMBER_OAUTH_PENDING_COOKIE);
    return response;
  } catch (e) {
    console.error("[apply] Не удалось создать рапорт:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}