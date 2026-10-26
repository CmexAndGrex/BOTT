"use client";

/**
 * Виджеты личного кабинета: статус дежурства («Кто на ВЧ») и сетка техники.
 *
 * Вынесены из страницы /profile, чтобы та читалась как последовательность
 * состояний (загрузка → вход → досье), а не как «простыня» разметки. Логика
 * допуска не дублируется: карточки техники рисуются по отчёту из API, который
 * посчитан боевым getAvailableVehicles() на сервере.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge, CheckCircle2, Clock3, Crosshair, Crown, FileText, Gauge, Gem, Lock, LockOpen, Medal,
  MessageCircle, Palmtree, RadioTower, RefreshCw, Send, ShieldAlert, ShieldCheck, Truck, Users,
  Wrench, X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { Section, Spinner, fmtDate } from "@/components/ui";
import { resolveAvatarUrl } from "@/lib/discord-avatar";
import { ReportForm, type SessionMember } from "@/components/reports-panel";
import { reportTypeMeta, type ServiceReportType } from "@/lib/reports";
import {
  VEHICLE_CATEGORY_LABELS,
  VEHICLE_VIP_FILTERS,
  matchesVipFilter,
  vipFilterCounts,
  type Vehicle,
  type VehicleAccessReport,
  type VehicleCard,
  type VehicleVipFilter,
} from "@/lib/vehicles";

/* ------------------------------------------------------------------ */
/* Шапка досье: позывной, звание, подразделение и статус службы         */
/* ------------------------------------------------------------------ */

/** Боец в ответе /api/member/dossier */
export type DossierMember = {
  id: number;
  callsign: string;
  /** Официальное ФИО из табеля: приоритетнее позывного в заголовке досье */
  name?: string;
  rank: string;
  unit: string | null;
  post: string | null;
  status: string;
  role: string;
  avatarUrl: string | null;
  discordId: string | null;
  hours: number;
  warnings: number;
  createdAt: string;
};

/** Статус службы в ответе /api/member/dossier */
export type DossierService = {
  status: "active" | "vacation" | "reserve";
  label: string;
  tone: "ok" | "info" | "muted";
  badgeClass: string;
  untilLabel: string | null;
  until: string | null;
  daysLeft: number | null;
  daysLabel: string | null;
  overdue: boolean;
};

/**
 * Шапка досье.
 *
 * Позывной, звание с подразделением, привязанные контакты и пилюля статуса
 * службы. Пилюля собрана на сервере (serviceStatus в dossier.ts): расчёт
 * «до 20.11.2026 осталось 3 дня» идёт по московским суткам, и делать это в
 * браузере с чужой зоной было бы ошибкой.
 */
export function DossierHeader({
  member,
  service,
  onReport,
  onLogout,
}: {
  member: DossierMember;
  service: DossierService;
  onReport: () => void;
  onLogout: () => void;
}) {
  /**
   * Аватар: сохранённый адрес Discord пересобирается под нужный размер, а если
   * картинки нет — берётся дефолтная по Discord ID. Сбой загрузки (403/404)
   * переводит шапку на «тактическую» заглушку, а не оставляет пустой квадрат.
   */
  const [avatarFailed, setAvatarFailed] = useState(false);
  const avatarSrc = avatarFailed ? null : resolveAvatarUrl(member.avatarUrl, member.discordId, 128);

  const division =
    member.unit === "Танковая рота"
      ? "Танковая рота"
      : member.unit === "Артиллерийский дивизион"
        ? "Арт. дивизион"
        : member.unit;

  return (
    <header className="card card-glow-red px-5 py-5">
      <div className="flex flex-wrap items-start gap-5">
        {/* Аватар: без картинки — «тактическая» заглушка с инициалами позывного */}
        <div className="flex items-center gap-4">
          {avatarSrc ? (
            // eslint-disable-next-line @next/next/no-img-element -- аватар Discord с внешнего хоста
            <img
              src={avatarSrc}
              alt={member.callsign}
              width={72}
              height={72}
              // Discord CDN отвечает 403 Forbidden на чужой Referer — без этого
              // атрибута в досье оставался пустой квадрат
              referrerPolicy="no-referrer"
              loading="lazy"
              decoding="async"
              onError={() => setAvatarFailed(true)}
              style={{ width: 72, height: 72, borderRadius: 18, objectFit: "cover", flex: "none" }}
            />
          ) : (
            <div
              className="flex items-center justify-center"
              style={{
                width: 72,
                height: 72,
                borderRadius: 18,
                background: "var(--red-soft)",
                color: "var(--red)",
                flex: "none",
              }}
            >
              <ShieldCheck size={28} />
            </div>
          )}

          <div className="min-w-0">
            <div className="eyebrow mb-1">личное дело // досье</div>
            {/*
              Заголовок — официальное ФИО из табеля, а не технический логин:
              «Иванов И.А.», а не «Ivanov_IA». Позывной остаётся запасным
              вариантом (у бойцов из синхронизации rs-red.com ФИО может
              совпадать с позывным или отсутствовать).
            */}
            <h1 className="display text-[28px] font-black leading-tight">
              {member.name || member.callsign}
            </h1>
            {member.name && member.callsign && member.name !== member.callsign && (
              <div className="text-[11.5px]" style={{ color: "var(--dim)" }}>
                позывной: {member.callsign}
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="chip" style={{ fontSize: "0.72rem" }}>
                <Badge size={12} style={{ color: "var(--red)" }} />
                {member.rank || "звание не указано"}
              </span>
              {division && (
                <span className="chip" style={{ fontSize: "0.72rem" }}>
                  <Crosshair size={12} style={{ color: "var(--dim)" }} />
                  {division}
                </span>
              )}
              {member.post && (
                <span className="chip" style={{ fontSize: "0.72rem" }}>
                  {member.post}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="ml-auto flex flex-col items-end gap-2">
          {/* Пилюля статуса службы: зелёная «В строю», синяя «В отпуске» с датой
              возвращения, серо-стальная «В резерве» */}
          <span className={`badge ${service.badgeClass}`}>
            {service.status === "vacation" ? <Palmtree size={12} /> : <ShieldCheck size={12} />}
            {service.label}
          </span>
          {service.status === "vacation" && (
            <div className="text-right text-[11.5px]" style={{ color: "var(--blue)" }}>
              {service.untilLabel}
              {service.daysLabel ? ` · ${service.daysLabel}` : ""}
              {service.overdue && (
                <div style={{ color: "var(--amber)" }}>
                  дата возвращения прошла — штабу нужно снять статус
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button type="button" className="btn btn-primary px-4 py-2" onClick={onReport}>
              <Send size={15} /> Подать рапорт
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onLogout}
              style={{ background: "color-mix(in srgb, var(--red) 10%, transparent)", borderColor: "transparent", color: "var(--red)" }}
            >
              Выйти
            </button>
          </div>
        </div>
      </div>

      {/* Контакты и служебные числа: то, что боец сверяет чаще всего */}
      <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-4 text-[11.5px]" style={{ borderColor: "var(--stroke-soft)", color: "var(--dim)" }}>
        <span className="chip mono" style={{ fontSize: "0.7rem" }}>
          <MessageCircle size={12} style={{ color: member.discordId ? "var(--green)" : "var(--dim)" }} />
          Discord: {member.discordId || "не привязан"}
        </span>
        <span className="chip" style={{ fontSize: "0.7rem" }}>
          <Clock3 size={12} style={{ color: "var(--dim)" }} />
          налетано: {member.hours.toFixed(1)} ч
        </span>
        {member.warnings > 0 && (
          <span className="badge badge-amber">
            предупреждений: {member.warnings} / 2
          </span>
        )}
        <span className="ml-auto">
          в системе с {new Date(member.createdAt).toLocaleDateString("ru-RU")}
        </span>
      </div>
    </header>
  );
}

/** Ответ /api/member/vch */
export type VchResponse = {
  ok: boolean;
  online: boolean;
  onlineCount: number;
  maxPlayers: number;
  map: string | null;
  /** Боец сессии найден среди игроков сервера */
  selfOnline: boolean;
  clanMembersOnline: { id: number; callsign: string; rank: string; division: string | null }[];
  clanOnlineCount: number;
  notice: string | null;
  error?: string;
};

/**
 * Бейдж дежурства.
 *
 * Три различимых состояния, и они не смешиваются: боец на сервере («в бою»,
 * зелёный, с картой и миссией), сервер отвечает без него (население сервера),
 * сервер недоступен (заглушка). Раньше любое из них показывалось одним серым
 * «нет данных»: боец, который уже в игре, не видел подтверждения, а выключенный
 * сервер выглядел ошибкой.
 *
 * Опрашивается раз в минуту — ровно как TTL кэша на сервере: чаще смысла нет
 * (данные всё равно те же), реже боец не увидит свежий состав. Кнопка
 * «Обновить» шлёт ?force=1 и перебивает кэш.
 */
export function GarrisonWidget({
  onNotice,
  memberId,
}: {
  onNotice?: (text: string) => void;
  /**
   * Id бойца сессии: его строка в списке помечается «вы».
   *
   * Необязателен намеренно — виджет остаётся рабочим и без досье (страница может
   * отрисовать его до загрузки личного дела), а сам статус «в бою» считает
   * сервер по сессии, а не браузер.
   */
  memberId?: number;
}) {
  const [data, setData] = useState<VchResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (force = false) => {
    try {
      const res = await fetch(`/api/member/vch${force ? "?force=1" : ""}`, { cache: "no-store" });
      const body = (await res.json()) as VchResponse;
      if (body?.ok) setData(body);
    } catch {
      // Сбой сети не показываем красным: виджет дежурства вторичен по отношению
      // к досье, и честное «нет данных» здесь лучше ошибки на всю карточку
      setData(null);
    } finally {
      setLoading(false);
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(false), 0);
    const interval = window.setInterval(() => void load(false), 60_000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(interval);
    };
  }, [load]);

  const refresh = () => {
    setBusy(true);
    void load(true).then(() => onNotice?.("Список дежурства обновлён"));
  };

  const onDuty = data?.clanMembersOnline ?? [];
  const serverOnline = Boolean(data?.online);
  const selfOnline = Boolean(data?.online && data?.selfOnline);
  /** Карта/миссия сервера — показывается и «в бою», и в строке населения */
  const mapLabel = data?.map ? `карта: ${data.map}` : null;

  return (
    <Section
      title="На дежурстве / На ВЧ"
      eyebrow="живой состав на сервере"
      action={
        <button type="button" className="btn btn-sm" onClick={refresh} disabled={busy}>
          {busy ? <Spinner /> : <RefreshCw size={14} />} Обновить
        </button>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          {/* Живой бейдж: зелёный — боец на сервере, зелёный с числом — свои без
              него, синий — сервер отвечает, но своих нет, серо-стальной — сервер
              недоступен или данных нет вовсе */}
          <span
            className={`badge ${
              selfOnline
                ? "badge-green"
                : onDuty.length > 0
                  ? "badge-green"
                  : serverOnline
                    ? "badge-info"
                    : "badge-reserve"
            }`}
          >
            {selfOnline ? (
              <>
                <span className="dot dot-ok pulse-dot" />
                <Crosshair size={12} />
                в бою / на сервере
              </>
            ) : (
              <>
                <RadioTower size={12} />
                {loading
                  ? "опрос…"
                  : onDuty.length > 0
                    ? `на ВЧ: ${onDuty.length}`
                    : serverOnline
                      ? `Сервер онлайн (Игроков: ${data?.onlineCount ?? 0})`
                      : "Сервер недоступен"}
              </>
            )}
          </span>

          {serverOnline && (
            <span className="chip mono" style={{ fontSize: "0.72rem" }}>
              <Users size={12} style={{ color: "var(--dim)" }} />
              всего на сервере: {data?.onlineCount ?? 0}
              {data?.maxPlayers ? ` / ${data.maxPlayers}` : ""}
            </span>
          )}
          {mapLabel && (
            <span className="chip" style={{ fontSize: "0.72rem" }}>
              {mapLabel}
            </span>
          )}
        </div>

        {onDuty.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {onDuty.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-3 rounded-xl px-3 py-2.5"
                style={{
                  border: "1px solid rgba(16,185,129,.22)",
                  background: "rgba(16,185,129,.05)",
                }}
              >
                <span className="dot dot-ok pulse-dot" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold">{entry.callsign}</span>
                    {/* Своя строка в списке: боец сразу видит себя, а не выискивает
                        позывной глазами */}
                    {memberId === entry.id && (
                      <span className="badge badge-green" style={{ fontSize: "0.6rem" }}>
                        вы
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px]" style={{ color: "var(--dim)" }}>
                    {[entry.rank, entry.division].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          // Пустое состояние: факты разные (сервер молчит / на нём нет своих), но
          // вывод для бойца один — в списке дежурства его нет
          <p className="text-[12.5px] leading-relaxed" style={{ color: "var(--muted)" }}>
            {loading
              ? "Опрашиваем сервер…"
              : serverOnline
                ? "На сервере сейчас никого из подразделения — заходите, будете первым."
                : data?.notice || "Сервер недоступен. Данные о дежурстве временно недоступны."}
          </p>
        )}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Техника: вкладки «доступная» и «требует сдачи / повышения»          */
/* ------------------------------------------------------------------ */

const CATEGORY_ICON: Record<Vehicle["category"], typeof Truck> = {
  tank: Crosshair,
  ifv: Truck,
  spg: Gauge,
  mlrs: Crosshair,
  sam: ShieldCheck,
  mortar: Wrench,
};

/** Цена единицы техники: null — «по решению штаба» (техника ивентов) */
function priceLabel(vehicle: Vehicle): string {
  return vehicle.price === null ? "по решению штаба" : `$${vehicle.price}`;
}

/**
 * Оформление уровней VIP: VIP 1 — янтарное золото, VIP 2 — пурпур.
 *
 * Цвета вынесены в константы, а не разбросаны по разметке: один и тот же
 * уровень должен выглядеть одинаково и на бейдже карточки, и на кнопке фильтра,
 * иначе боец перестаёт связывать кнопку с техникой.
 */
const VIP_STYLE: Record<1 | 2, { color: string; label: string; icon: typeof Crown }> = {
  1: { color: "var(--amber)", label: "VIP 1", icon: Crown },
  2: { color: "#c084fc", label: "VIP 2", icon: Gem },
};

/** Бейдж уровня VIP: на базовой технике не рисуется — там нечего сообщать */
function VipBadge({ tier }: { tier: Vehicle["vipTier"] }) {
  if (tier === 0) return null;
  const style = VIP_STYLE[tier];
  const Icon = style.icon;
  return (
    <span
      className="badge"
      style={{
        fontSize: "0.6rem",
        color: style.color,
        background: `color-mix(in srgb, ${style.color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${style.color} 38%, transparent)`,
      }}
    >
      <Icon size={11} />
      {style.label}
    </span>
  );
}

/** Бейдж минимального звания: «Лейтенант» — то, что требует реестр гаража */
function RankBadge({ rank }: { rank: NonNullable<Vehicle["requiredRank"]> }) {
  return (
    <span className="badge badge-reserve" style={{ fontSize: "0.6rem" }} title="Минимальное звание">
      <Medal size={11} />
      {rank}
    </span>
  );
}

/** Карточка единицы техники: название, категория, цена и состояние допуска */
function VehicleTile({ card }: { card: VehicleCard }) {
  const Icon = CATEGORY_ICON[card.vehicle.category] ?? Truck;
  const unlocked = card.status === "unlocked";

  return (
    <div
      className="flex flex-col gap-2 rounded-xl px-3.5 py-3"
      style={{
        border: `1px solid ${unlocked ? "rgba(16,185,129,.28)" : "var(--stroke-soft)"}`,
        background: unlocked ? "rgba(16,185,129,.05)" : "rgba(255,255,255,.015)",
      }}
    >
      <div className="flex items-start gap-2.5">
        <Icon
          size={16}
          style={{ color: unlocked ? "var(--green)" : "var(--dim)", flex: "none", marginTop: 2 }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold leading-snug">{card.vehicle.name}</div>
          <div
            className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px]"
            style={{ color: "var(--dim)" }}
          >
            <span>{VEHICLE_CATEGORY_LABELS[card.vehicle.category]}</span>
            {card.vehicle.mod && (
              <span className="chip" style={{ fontSize: "0.6rem" }}>
                {card.vehicle.mod}
              </span>
            )}
            <span className="mono">{priceLabel(card.vehicle)}</span>
          </div>
        </div>
        {unlocked ? (
          <LockOpen size={14} style={{ color: "var(--green)", flex: "none" }} />
        ) : (
          <Lock size={14} style={{ color: "var(--dim)", flex: "none" }} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`badge ${unlocked ? "badge-green" : "badge-amber"}`}
          style={{ fontSize: "0.62rem" }}
        >
          {card.statusLabel}
        </span>
        <VipBadge tier={card.vehicle.vipTier} />
        {card.vehicle.requiredRank && <RankBadge rank={card.vehicle.requiredRank} />}
        {!unlocked && card.missing.length > 0 && (
          <span className="text-[11px]" style={{ color: "var(--amber)" }}>
            нужно: {card.missing.join(", ")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Переключатель уровней VIP: «Все · Базовая · VIP 1 · VIP 2» со счётчиками.
 *
 * Фильтр работает только на клиенте и ничего не перезапрашивает: списки открытой
 * и закрытой техники уже приехали в отчёте досье, и фильтрация — это отбор из
 * готового массива. Счётчики считаются по тому же массиву, что и показывается,
 * поэтому цифра на кнопке всегда совпадает с числом карточек под ней.
 */
function VipFilterBar({
  value,
  counts,
  onChange,
}: {
  value: VehicleVipFilter;
  counts: Record<VehicleVipFilter, number>;
  onChange: (next: VehicleVipFilter) => void;
}) {
  const labelOf = (key: VehicleVipFilter): string =>
    key === "all" ? "Все" : key === "base" ? "Базовая" : VIP_STYLE[key === "vip1" ? 1 : 2].label;
  const accentOf = (key: VehicleVipFilter): string | null =>
    key === "vip1" ? VIP_STYLE[1].color : key === "vip2" ? VIP_STYLE[2].color : null;

  return (
    <div
      className="inline-flex flex-wrap items-center gap-1 rounded-full p-1"
      style={{ border: "1px solid var(--stroke)", background: "rgba(255,255,255,.02)" }}
      role="group"
      aria-label="Фильтр техники по уровню VIP"
    >
      {VEHICLE_VIP_FILTERS.map((key) => {
        const active = value === key;
        const accent = accentOf(key);
        // Активная кнопка окрашивается в цвет своего уровня: янтарная для VIP 1,
        // пурпурная для VIP 2, фирменная бордовая — для «Все» и «Базовая».
        const activeColor = accent ?? "#fff";
        return (
          <button
            key={key}
            type="button"
            className="chip"
            aria-pressed={active}
            onClick={() => onChange(key)}
            style={{
              borderRadius: 999,
              fontSize: "0.72rem",
              ...(active
                ? accent
                  ? {
                      background: `color-mix(in srgb, ${accent} 14%, transparent)`,
                      borderColor: `color-mix(in srgb, ${accent} 42%, transparent)`,
                      color: activeColor,
                    }
                  : {
                      background: "var(--red-soft)",
                      borderColor: "rgba(190,18,60,.45)",
                      color: activeColor,
                    }
                : accent
                  ? { color: `color-mix(in srgb, ${accent} 72%, var(--muted))` }
                  : undefined),
            }}
          >
            {labelOf(key)}
            <span className="mono" style={{ fontSize: "0.66rem", opacity: 0.75 }}>
              {counts[key]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Полоса прогресса до следующего допуска: бордовый градиент с неоновым отсветом */
function ProgressBar({ percent }: { percent: number }) {
  return (
    <div className="hours-track" style={{ width: "100%" }}>
      <div
        className="hours-fill"
        style={{
          width: `${Math.max(0, Math.min(100, percent))}%`,
          background: "var(--red-grad)",
          boxShadow: "var(--red-glow)",
        }}
      />
    </div>
  );
}

/**
 * Сетка техники: две вкладки и прогресс до следующего допуска.
 *
 * Танковая рота показывает ступени по званиям (что открыто сейчас и что даст
 * ближайшее повышение), артиллерия — категории допуска с явными пилюлями
 * «Допуск получен» / «Требуется сдача норматива».
 */
export function VehicleAccessGrid({ report }: { report: VehicleAccessReport }) {
  const [tab, setTab] = useState<"unlocked" | "locked">("unlocked");
  /**
   * Уровень VIP, выбранный фильтром. Живёт отдельно от вкладки и её не сбрасывает:
   * боец смотрит «что даст повышение» и одновременно уточняет «только VIP 2».
   */
  const [vip, setVip] = useState<VehicleVipFilter>("all");

  const chipStyle = (active: boolean) =>
    active
      ? { background: "var(--red-soft)", borderColor: "rgba(190,18,60,.45)", color: "#fff" }
      : undefined;

  const activeList = tab === "unlocked" ? report.unlocked : report.locked;
  /**
   * Счётчики и отбор считаются от списка текущей вкладки. useMemo не для
   * «оптимизации» на два десятка карточек, а чтобы не пересоздавать массив на
   * каждом рендере виджета: фильтр обязан быть мгновенным и без внешних запросов.
   */
  const counts = useMemo(() => vipFilterCounts(activeList), [activeList]);
  const shown = useMemo(
    () => activeList.filter((card) => matchesVipFilter(card.vehicle, vip)),
    [activeList, vip]
  );

  if (report.division === "unknown") {
    return (
      <Section title="Техника" eyebrow="доступ по подразделению">
        <p className="px-5 py-6 text-[13px]" style={{ color: "var(--dim)" }}>
          Подразделение ещё не назначено — матрица допуска появится после зачисления в роту или
          дивизион. Допуск выдаётся по званию (Танковая рота) либо по сданным нормативам ШДС
          (Артиллерийский дивизион).
        </p>
      </Section>
    );
  }

  const nextTier =
    report.division === "tank" && report.progress.next
      ? report.tiers.find((tier) => tier.rank === report.progress.next)
      : null;

  return (
    <Section
      title="Техника"
      eyebrow={report.summary}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="chip"
            style={chipStyle(tab === "unlocked")}
            onClick={() => setTab("unlocked")}
          >
            Доступная техника ({report.unlocked.length})
          </button>
          <button
            type="button"
            className="chip"
            style={chipStyle(tab === "locked")}
            onClick={() => setTab("locked")}
          >
            Требует сдачи / повышения ({report.locked.length})
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 p-5">
        {/* Прогресс: до следующего звания (рота) либо до ближайшей категории (АД) */}
        {report.progress.next && (
          <div
            className="flex flex-col gap-2 rounded-xl px-3.5 py-3"
            style={{ background: "rgba(255,255,255,.025)" }}
          >
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="label">следующий допуск</span>
              <span className="font-semibold">{report.progress.next}</span>
              <span className="ml-auto mono text-[11.5px]" style={{ color: "var(--dim)" }}>
                {report.progress.satisfied} / {report.progress.total}
              </span>
            </div>
            <ProgressBar percent={report.progress.percent} />
            {report.progress.missing.length > 0 && (
              <span className="text-[11.5px]" style={{ color: "var(--amber)" }}>
                нужно: {report.progress.missing.join(", ")}
              </span>
            )}
          </div>
        )}

        {/* Танковая рота: предпросмотр ближайшей ступени — что именно откроется */}
        {nextTier && (
          <div
            className="rounded-xl px-3.5 py-3"
            style={{ border: "1px dashed var(--stroke)", background: "rgba(255,176,32,.04)" }}
          >
            <div className="mb-2 text-[11.5px]" style={{ color: "var(--amber)" }}>
              Откроется на звании «{nextTier.rank}»: {nextTier.vehicles.length} ед. техники
            </div>
            <div className="flex flex-wrap gap-1.5">
              {nextTier.vehicles.map((card) => (
                <span key={card.vehicle.id} className="chip" style={{ fontSize: "0.68rem" }}>
                  {card.vehicle.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Артиллерия: категории допуска со статусом каждого норматива */}
        {report.division === "artillery" && report.categories.length > 0 && (
          <div className="flex flex-col gap-2">
            {report.categories.map((category) => (
              <div
                key={category.key}
                className="flex flex-wrap items-center gap-2 rounded-xl px-3.5 py-2.5"
                style={{ border: "1px solid var(--stroke-soft)" }}
              >
                <span className="text-[12.5px] font-semibold">{category.title}</span>
                <span
                  className={`badge ${category.unlocked ? "badge-green" : "badge-amber"}`}
                  style={{ fontSize: "0.62rem" }}
                >
                  {category.statusLabel}
                </span>
                <span className="text-[11.5px]" style={{ color: "var(--dim)" }}>
                  {category.unlocked
                    ? `нормативы: ${category.satisfied.join(", ")}`
                    : `нужно сдать: ${category.missing.join(", ")}`}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Фильтр по уровню VIP: мгновенный отбор внутри выбранной вкладки */}
        <VipFilterBar value={vip} counts={counts} onChange={setVip} />

        {shown.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {shown.map((card) => (
              <VehicleTile key={card.vehicle.id} card={card} />
            ))}
          </div>
        ) : (
          <p className="text-[12.5px]" style={{ color: "var(--dim)" }}>
            {counts.all === 0
              ? tab === "unlocked"
                ? "Пока ничего не открыто — начните с базовых нормативов и ближайшего повышения."
                : "Вся техника подразделения открыта. Дальше — только по решению штаба."
              : "В этой категории техники нет — переключите уровень VIP или вкладку."}
          </p>
        )}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Подача рапорта из досье: модальное окно с вкладками типов           */
/* ------------------------------------------------------------------ */

/**
 * Вкладки окна — три коротких пути из ТЗ.
 *
 * Полный перечень типов рапортов открыт на /reports: здесь оставлены те, что
 * боец подаёт чаще всего, чтобы не заставлять его искать «Отпуск» в общем списке
 * из пяти пунктов. Порядок — как в задании: экзамен, отпуск, перевод.
 */
export const DOSSIER_REPORT_TABS: readonly ServiceReportType[] = [
  "exam",
  "vacation",
  "role",
  // Перевод по должности ШДС: рапорт подаётся не из раздела «Экзамены», а здесь.
  // Без него тип рапорта существовал бы только в API, и боец не смог бы его подать
  "position_transfer",
];

/**
 * Модальное окно подачи рапорта.
 *
 * Формы не переписаны заново: используется ReportForm из reports-panel.tsx —
 * тот же компонент, что и на странице /reports. Второй набор полей разошёлся бы
 * с первым при первой же правке валидатора (validateReportPayload).
 */
export function ReportModal({
  open,
  member,
  tab,
  presetExams = [],
  onTabChange,
  sending = false,
  error = "",
  notice = "",
  onSubmit,
  onClose,
}: {
  open: boolean;
  member: SessionMember | null;
  /**
   * Активная вкладка окна.
   *
   * Состояние держит вызывающая сторона (лаунчер в сайдбаре или страница
   * кабинета), а не само окно: так «открыть сразу на нужной вкладке» — обычная
   * смена состояния в обработчике клика, без синхронизации пропсов эффектом
   * (setState в эффекте дал бы лишний рендер и замечание react-hooks).
   */
  tab: ServiceReportType;
  /** Нормативы, отмеченные при открытии окна (кнопка «Сдать норматив») */
  presetExams?: readonly string[];
  onTabChange: (type: ServiceReportType) => void;
  /** Идёт отправка: кнопки формы блокируются */
  sending?: boolean;
  /** Ошибка отправки (показывается внутри окна) */
  error?: string;
  /** Сообщение об успехе (окно закрывается само, текст нужен до закрытия) */
  notice?: string;
  onSubmit: (
    type: ServiceReportType,
    payload: unknown,
    reset: () => void
  ) => Promise<void> | void;
  onClose: () => void;
}) {
  // Esc закрывает окно — привычный способ выйти из модального окна
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
          style={{ background: "var(--overlay)", backdropFilter: "blur(4px)" }}
          onClick={onClose}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 14 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className="card my-6 w-full max-w-[720px]"
            style={{
              background: "var(--modal)",
              backdropFilter: "blur(14px)",
              borderColor: "rgba(190,18,60,0.28)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <header
              className="flex items-center gap-3 border-b px-5 py-4"
              style={{ borderColor: "var(--stroke-soft)" }}
            >
              <span
                className="flex shrink-0 items-center justify-center"
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 12,
                  background: "var(--red-soft)",
                  color: "var(--red)",
                }}
              >
                <Send size={17} />
              </span>
              <div className="min-w-0">
                <div className="label">подача рапорта</div>
                <h2 className="display text-[15px] font-bold">Новый рапорт</h2>
              </div>
              <button
                type="button"
                className="btn btn-icon ml-auto"
                onClick={onClose}
                aria-label="Закрыть"
              >
                <X size={15} />
              </button>
            </header>

            {/* Вкладки типов: активная подсвечена, как в остальных переключателях панели */}
            <div className="flex flex-wrap gap-2 px-5 pt-4">
              {DOSSIER_REPORT_TABS.map((type) => {
                const meta = reportTypeMeta(type);
                const active = tab === type;
                return (
                  <button
                    key={type}
                    type="button"
                    className="chip"
                    onClick={() => onTabChange(type)}
                    style={
                      active
                        ? {
                            background: "var(--red-soft)",
                            borderColor: "rgba(190,18,60,.45)",
                            color: "#fff",
                          }
                        : undefined
                    }
                  >
                    <span aria-hidden>{meta.icon}</span> {meta.label}
                  </button>
                );
              })}
            </div>

            {/* Сообщения внутри окна: окно может закрыться само после успеха,
                поэтому ошибка видна именно здесь, а не на странице */}
            {error && (
              <div
                className="mx-5 mt-4 flex items-center gap-2 rounded-xl px-3 py-2.5"
                style={{ background: "rgba(190,18,60,.08)", border: "1px solid rgba(190,18,60,.35)" }}
              >
                <ShieldAlert size={15} style={{ color: "var(--red)", flex: "none" }} />
                <span className="text-[12.5px]" style={{ color: "var(--red)" }}>
                  {error}
                </span>
              </div>
            )}
            {notice && (
              <div
                className="mx-5 mt-4 flex items-center gap-2 rounded-xl px-3 py-2.5"
                style={{ background: "rgba(16,185,129,.08)", border: "1px solid rgba(16,185,129,.35)" }}
              >
                <CheckCircle2 size={15} style={{ color: "var(--green)", flex: "none" }} />
                <span className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                  {notice}
                </span>
              </div>
            )}

            <div className="px-5 pb-5 pt-4">
              <ReportForm
                // Ключ пересоздаёт форму при смене вкладки или предвыбора: без него
                // состояние чекбоксов осталось бы от прошлого открытия окна, и
                // предвыбор «Сдать норматив» не применился бы ко второму нормативу
                key={`${tab}:${presetExams.join("|")}`}
                member={member}
                type={tab}
                presetExams={presetExams}
                sending={sending}
                // «Другой тип» внутри окна: вкладки уже переключаются чипами выше,
                // поэтому null (возврат к списку типов) здесь просто игнорируется —
                // закрывать окно ради выбора типа не нужно
                onPickType={(next) => { if (next) onTabChange(next); }}
                onSubmit={onSubmit}
              />
              <p className="mt-3 text-[11.5px]" style={{ color: "var(--dim)" }}>
                Остальные типы рапортов (запись в ШДС, перевод в резерв) — в разделе «Мои рапорты».
              </p>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* История службы: таблица поданных рапортов                           */
/* ------------------------------------------------------------------ */

/** Рапорт в ответе /api/member/dossier */
export type DossierReport = {
  id: number;
  type: ServiceReportType;
  status: "pending" | "approved" | "rejected";
  statusLabel: string;
  badgeClass: string;
  createdAt: string;
  reviewedBy: string | null;
  moderatorComment: string | null;
  summary: string;
};

/**
 * Таблица «Мои рапорты» с датой, типом, статусом и комментарием офицера.
 *
 * Отдельно от MyReports из reports-panel.tsx: там лента для страницы подачи,
 * здесь — таблица истории службы, где на виду решение штаба и причина отказа.
 * Данные приходят одним запросом досье, второй раз в БД не идём.
 */
export function ServiceHistory({ reports }: { reports: DossierReport[] }) {
  if (reports.length === 0) {
    return (
      <Section title="Мои рапорты" eyebrow="подано: 0">
        <p className="px-5 py-6 text-[13px]" style={{ color: "var(--dim)" }}>
          Рапортов пока нет. Нажмите «Подать рапорт» — экзамены, отпуск и перевод подаются оттуда.
        </p>
      </Section>
    );
  }

  return (
    <Section title="Мои рапорты" eyebrow={`подано: ${reports.length}`}>
      <div className="overflow-x-auto">
        <table className="tbl" style={{ minWidth: 720 }}>
          <thead>
            <tr>
              <th>Дата</th>
              <th>Тип</th>
              <th>Суть</th>
              <th style={{ textAlign: "center" }}>Статус</th>
              <th>Решение штаба</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((row) => {
              const meta = reportTypeMeta(row.type);
              return (
                <tr key={row.id}>
                  <td
                    className="mono text-[12px]"
                    style={{ color: "var(--muted)", whiteSpace: "nowrap" }}
                  >
                    {fmtDate(row.createdAt)}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <span aria-hidden className="mr-1.5">
                      {meta.icon}
                    </span>
                    <span className="text-[12.5px]">{meta.label}</span>
                  </td>
                  <td className="text-[12.5px]" style={{ color: "var(--muted)" }}>
                    {row.summary || "—"}
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <span className={`badge ${row.badgeClass}`}>{row.statusLabel}</span>
                  </td>
                  <td className="text-[12px]">
                    {row.moderatorComment ? (
                      <span
                        style={{
                          color: row.status === "rejected" ? "var(--red)" : "var(--muted)",
                        }}
                      >
                        {row.moderatorComment}
                      </span>
                    ) : (
                      <span style={{ color: "var(--dim)" }}>
                        {row.reviewedBy ? `решение: ${row.reviewedBy}` : "ожидает рассмотрения"}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div
        className="flex items-center gap-2 px-5 py-3 text-[11.5px]"
        style={{ color: "var(--dim)" }}
      >
        <FileText size={13} />
        Статусы: «На рассмотрении» — рапорт у штаба, «Одобрено» — изменения внесены, «Отклонено» —
        причина в комментарии.
      </div>
    </Section>
  );
}