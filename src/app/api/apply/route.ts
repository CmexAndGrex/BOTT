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
  APPLICATION_KIND_LABELS,
  APPLICATION_KIND_RECRUIT,
  APPLICATION_KIND_RESERVE_RETURN,
  DEFAULT_APPLICATION_KIND,
  DEFAULT_RANK,
  FULL_NAME_MAX_LENGTH,
  FULL_NAME_MIN_LENGTH,
  isCallsign,
  isDiscordSnowflake,
  isFullName,
  isRecruitApplicationKind,
  LoginThrottle,
  MANUAL_DISCORD_ID,
  normalizeCallsign,
  normalizeFullName,
  PENDING_NOTICE,
  readApplication,
  validateApplication,
  type RecruitApplicationKind,
} from "@/lib/recruits";
import { registerThrottle } from "@/lib/throttle-registry";

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
const throttle = registerThrottle(new LoginThrottle(5, 30 * 60 * 1000));

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
  /** Вид заявки: recruit (по умолчанию) или reserve_return */
  kind?: unknown;
  /** ФИО возвращающегося из запаса: по нему ищется строка на листе «Запас» */
  fullName?: unknown;
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

  /**
   * Вид заявки. Неизвестное значение трактуем как «новобранец», а не как
   * ошибку: прежние клиенты поля не шлют вовсе, и заявка обязана приниматься.
   * Возврат из запаса отличается только решением модератора — набор полей
   * анкеты тот же, поэтому отдельной ветки проверки не требуется.
   */
  const kind: RecruitApplicationKind = isRecruitApplicationKind(body.kind)
    ? body.kind
    : DEFAULT_APPLICATION_KIND;

  /**
   * ФИО обязательно только для возврата: по нему модератор и бот находят
   * строку бойца на листе «Запас». Для новобранца поле не нужно — оно и
   * раньше не заполнялось.
   */
  const fullName = kind === APPLICATION_KIND_RESERVE_RETURN ? normalizeFullName(body.fullName) : "";
  if (kind === APPLICATION_KIND_RESERVE_RETURN && !isFullName(fullName)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Возврат из запаса: укажите ФИО так, как оно записано в табеле (${FULL_NAME_MIN_LENGTH}–${FULL_NAME_MAX_LENGTH} символов)`,
      },
      { status: 400 }
    );
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
    // Вид заявки решает, что обязательно: возврат из запаса анкеты не требует
    kind,
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
    // Вид заявки и ФИО передаются дальше: по ним модерация отличает возврат
    // из запаса от зачисления и находит строку бойца на листе «Запас»
    kind,
    fullName,
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
  input: ApplicationInput & { password: string; discordIdRaw: string }
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
    /**
     * Возврат из запаса: карточка бойца в панели УЖЕ существует (в запас
     * переводили именно её), поэтому новую создавать нельзя — иначе получился
     * бы дубль, а позывной занят (members.callsign уникален) и форма отвечала
     * бы «Позывной уже занят» самому же возвращающемуся.
     *
     * Поэтому здесь только находится прежняя карточка, а заявка привязывается
     * к ней. Никаких INSERT: восстановление выполняет approveReserveReturn
     * (active = true + перенос строки ШДС с листа «Запас»).
     */
    if (input.kind === APPLICATION_KIND_RESERVE_RETURN) {
      const all = await db.select().from(members);
      const wanted = input.fullName.toLowerCase();
      const callsignWanted = input.callsign.toLowerCase();
      const found = all.find(
        (row) =>
          (row.name || "").trim().toLowerCase() === wanted ||
          (row.callsign || "").trim().toLowerCase() === wanted ||
          (row.callsign || "").trim().toLowerCase() === callsignWanted
      );

      if (!found) {
        return NextResponse.json(
          {
            ok: false,
            error: `Боец «${input.fullName}» не найден в составе. Проверьте ФИО или обратитесь к штабу — заявку на возврат подаёт боец, уже переведённый в запас`,
          },
          { status: 404 }
        );
      }

      // В строю — возвращаться некуда: это не запас, и восстанавливать нечего
      if (found.active && found.status !== "dismissed") {
        return NextResponse.json(
          {
            ok: false,
            error: `«${found.callsign || found.name}» числится в строю — отдельная заявка на возврат не нужна`,
          },
          { status: 409 }
        );
      }

      return createApplicationForMember(req, ip, found, input, discordId, fromCookie);
    }

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

    return finalizeApplication(req, ip, created, input, discordId, fromCookie);
  } catch (e) {
    console.error("[apply] Не удалось создать рапорт:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}

/**
 * Проверенные данные заявки, передаваемые из основного обработчика в оформление.
 *
 * Общий тип для обеих веток — новобранца и возврата из запаса: после проверок
 * они неразличимы, кроме вида заявки и ФИО, а копия набора полей разошлась бы.
 */
type ApplicationInput = {
  callsign: string;
  discordTag: string;
  data: { age: number; armaExperience: string; specialization: string; comment: string };
  /** Вид заявки: recruit — зачисление, reserve_return — возврат из запаса */
  kind: RecruitApplicationKind;
  /** ФИО возвращающегося (пусто для новобранца) */
  fullName: string;
};

/**
 * Общий финал подачи заявки: запись в recruit_applications, публикация в
 * канале штаба, журнал и ответ кандидату.
 *
 * Вынесен отдельной функцией, потому что заявки подают два разных человека:
 * новобранец (карточку создаём здесь же) и возвращающийся из запаса (карточка
 * уже есть, и создавать её нельзя). Шаг после карточки у них одинаковый, а
 * копия кода разошлась бы — например, возврат потерял бы вид заявки и снова
 * показывался бы как обычное зачисление.
 */
async function finalizeApplication(
  req: NextRequest,
  ip: string,
  member: { id: number; callsign: string | null },
  input: ApplicationInput,
  discordId: string | null,
  fromCookie: ReturnType<typeof unpackDiscordProfile>
): Promise<NextResponse> {
  try {
    // Заявка дублируется в отдельную таблицу: именно её показывает канал
    // Discord с кнопками, и по ней принимается решение. Карточка бойца —
    // следствие решения, а не сама заявка.
    const [applicationRow] = await db
      .insert(recruitApplications)
      .values({
        memberId: member.id,
        callsign: member.callsign || input.callsign,
        // Вид заявки и ФИО хранятся в своих колонках: по ним модерация
        // отличает возврат из запаса от зачисления и находит строку бойца
        kind: input.kind,
        fullName: input.fullName || null,
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
          // Модератор сразу видит, что это возврат из запаса, а не зачисление:
          // заголовок Embed меняется вместе с видом заявки
          kind: applicationRow.kind,
          fullName: applicationRow.fullName,
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

    const isReserveReturn = input.kind === APPLICATION_KIND_RESERVE_RETURN;

    await db.insert(logs).values({
      category: "edit",
      author: input.callsign,
      action: isReserveReturn ? "подал запрос на возврат из запаса" : "подал рапорт на вступление",
      details: {
        "Позывной": input.callsign,
        "Вид заявки": APPLICATION_KIND_LABELS[input.kind],
        ...(input.fullName ? { "ФИО": input.fullName } : {}),
        "Возраст": String(input.data.age),
        "Специализация": input.data.specialization,
        "Discord": discordId || "не указан",
        "Источник": fromCookie ? "вход через Discord" : "ручной ввод",
      },
      kind: "system",
      title: isReserveReturn ? "Запрос на возврат из запаса" : "Новый рапорт",
      detail: isReserveReturn
        ? `Запрос на возврат из запаса от ${input.fullName} (позывной ${input.callsign}) ожидает решения штаба`
        : `Рапорт от ${input.callsign} ожидает рассмотрения штаба`,
      ok: true,
    });

    const response = NextResponse.json({
      ok: true,
      status: "pending",
      message: PENDING_NOTICE,
      callsign: member.callsign || input.callsign,
      kind: input.kind,
      application: readApplication(input.data),
    });
    // Контакт Discord больше не нужен: он сохранён в анкете
    response.cookies.delete(MEMBER_OAUTH_PENDING_COOKIE);
    return response;
  } catch (e) {
    console.error("[apply] Не удалось оформить заявку:", e);
    return NextResponse.json({ ok: false, error: "Ошибка сервера" }, { status: 500 });
  }
}

/**
 * Заявка на возврат из запаса по существующей карточке бойца.
 *
 * Новую карточку не создаём (members.callsign уникален, и боец уже есть в
 * табеле), а только оформляем заявку: решение по ней выполнит
 * approveReserveReturn — восстановит active и перенесёт строку ШДС.
 */
function createApplicationForMember(
  req: NextRequest,
  ip: string,
  member: typeof members.$inferSelect,
  input: ApplicationInput,
  discordId: string | null,
  fromCookie: ReturnType<typeof unpackDiscordProfile>
): Promise<NextResponse> {
  // Discord ID обновляем, только если у бойца его ещё нет: у возвращающегося
  // он обычно уже записан в табеле, и затирать его вводом из формы нельзя
  if (discordId && !member.discordId) {
    void db
      .update(members)
      .set({ discordId, updatedAt: new Date() })
      .where(eq(members.id, member.id))
      .catch((e) => console.error("[apply] Не удалось записать Discord ID:", e));
  }

  return finalizeApplication(
    req,
    ip,
    { id: member.id, callsign: member.callsign },
    input,
    discordId,
    fromCookie
  );
}