"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import React, { useEffect, useState } from "react";
import BackgroundSlideshow from "@/components/background";
import { ReportLauncherProvider, useReportLauncher } from "@/components/report-launcher";
import {
  Activity, BookOpen, Bot, ChevronDown, Crosshair, FilePlus2, Globe, GraduationCap, IdCard, Inbox,
  LayoutDashboard, LogIn, LogOut, ScrollText, Settings2, ShieldAlert, UserRound, Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { REPORT_TYPE_META, reportTypeMeta, type ServiceReportType } from "@/lib/reports";

type StatusResponse = {
  bot: { configured: boolean; ok: boolean; user?: { username: string }; error?: string };
  site: { ok: boolean; error?: string };
  schedulerAlive: boolean;
  timezone: string;
};

/**
 * Компактный индикатор состояния системы: одна строка вместо трёх карточек.
 *
 * Раньше блок занимал пол-подвала сайдбара («Система» + три строки с подписями).
 * Теперь это один flex-wrap-ряд: цветная точка и короткая подпись на каждый
 * сервис. Полная подпись осталась в title — при наведении видно, что именно
 * проверялось, поэтому сокращение ничего не скрывает.
 *
 * Строки собираются массивом, а не вложенным компонентом: компонент,
 * объявленный внутри рендера, ESLint справедливо считает ошибкой
 * (react-hooks/static-components) — состояние такого «компонента» сбрасывалось
 * бы на каждом рендере.
 */
function StatusBlock() {
  const [status, setStatus] = useState<StatusResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        const data = await res.json();
        if (!cancelled) setStatus(data);
      } catch {}
    };
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const tone = (ok: boolean | undefined) => (status ? (ok ? "dot-ok" : "dot-err") : "dot-dim");
  const items: { key: string; icon: LucideIcon; hint: string; title: string; state: string }[] = [
    {
      key: "bot",
      icon: Bot,
      hint: status ? (status.bot.ok ? `@${status.bot.user?.username ?? "онлайн"}` : "ошибка") : "…",
      title: "Discord-бот",
      state: tone(status?.bot.ok),
    },
    {
      key: "site",
      icon: Globe,
      hint: status ? (status.site.ok ? "rs-red доступен" : "rs-red недоступен") : "rs-red…",
      title: "Игровой сервер rs-red.com",
      state: tone(status?.site.ok),
    },
    {
      key: "scheduler",
      icon: Activity,
      hint: status ? (status.schedulerAlive ? "планировщик" : "планировщик стоит") : "планировщик…",
      title: "Планировщик пингов и снимков",
      state: tone(status?.schedulerAlive),
    },
  ];

  return (
    <div className="mt-auto px-1 pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: "var(--dim)" }}>
        {items.map(({ key, icon: Icon, hint, title, state }) => (
          <span key={key} className="flex items-center gap-1.5" title={title}>
            <span className={`dot ${state} ${state === "dot-err" ? "pulse-dot" : ""}`} />
            <Icon size={13} style={{ flex: "none" }} />
            <span className="text-[10.5px]" style={{ whiteSpace: "nowrap" }}>{hint}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  /**
   * Провайдер окна подачи рапорта обёрнут СНАРУЖИ каркаса: модальное окно и
   * кнопка «Подать рапорт» живут в сайдбаре, но хранить состояние формы в самом
   * Shell неудобно — так окно доступно и странице (useReportLauncher), и меню.
   */
  return (
    <ReportLauncherProvider>
      <ShellFrame>{children}</ShellFrame>
    </ReportLauncherProvider>
  );
}

/** Пункт меню сайдбара */
type NavItem = { href: string; label: string; icon: LucideIcon };

function ShellFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { openReport } = useReportLauncher();
  const [role, setRole] = useState("guest");
  /** Логин учётной записи панели — нужен в карточке пользователя у штаба */
  const [username, setUsername] = useState<string | null>(null);
  const [member, setMember] = useState<{ callsign: string; status: string; statusLabel: string } | null>(null);
  /**
   * Состояние личного кабинета из /api/me: ok | not_linked | no_access | no_session.
   *
   * Зачем отдельное состояние, если есть member: пункт меню «Личный кабинет»
   * должен быть виден не только бойцу с cookie кабинета, но и командиру,
   * вошедшему в панель, — его учётная запись тоже открывает личное дело.
   * И наоборот: гостю пункт показывать незачем, он ведёт в заглушку.
   */
  const [cabinet, setCabinet] = useState<string>("no_session");
  /**
   * Раскрытие списка типов у кнопки быстрого действия «Подать рапорт».
   *
   * Подменю больше не ведёт на отдельные страницы: клик по типу открывает
   * модальное окно сразу на нужной вкладке (см. report-launcher.tsx).
   */
  const [reportMenuOpen, setReportMenuOpen] = useState(false);

  useEffect(() => {
    fetch("/api/me", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        setRole(d.role || "guest");
        setUsername(d.username ?? null);
        setMember(d.member || null);
        setCabinet(d.cabinet || "no_session");
      })
      .catch(() => {});
  }, [pathname]);

  /**
   * Единый выход из карточки пользователя.
   *
   * Раньше в подвале стояли две кнопки — «Выйти из кабинета» и «Выйти из
   * панели», — и выбор между ними был неочевиден: у командира, вошедшего
   * дважды (панель + кабинет), обе выглядели нужными. Теперь одна кнопка
   * закрывает все действующие сессии: нажавший «Выйти» хочет выйти, а не
   * угадывать, какая из двух cookie ему мешает.
   */
  const handleLogoutAll = async () => {
    const calls: Promise<unknown>[] = [];
    if (member) calls.push(fetch("/api/auth/member-logout", { method: "POST" }));
    if (role !== "guest" || !member) calls.push(fetch("/api/logout", { method: "POST" }));
    await Promise.allSettled(calls);
    // Боец без сессии панели возвращается на вход в кабинет, остальные — на обзор
    window.location.href = member && role === "guest" ? "/login" : "/";
  };

  const isStaff = role === "officer" || role === "admin";

  /**
   * Меню сайдбара: две группы вместо одного длинного списка.
   *
   * «ОСНОВНОЕ» — то, чем пользуются каждый день: личное дело, обзор, состав,
   * арсенал, свои рапорты, документация. «УПРАВЛЕНИЕ» — только штаб: модерация
   * рапортов, журнал, контроль, настройки (админу).
   *
   * Дубли убраны: раньше здесь соседствовали «Рапорты» (/admin/recruits) и
   * «Рапорты и заявки» (/admin/reports) — по сути один раздел модерации, — а
   * боец не имел в сайдбаре ссылки на свои рапорты вовсе. Теперь у бойца —
   * «Мои рапорты» (/reports), у штаба — один пункт «Модерация рапортов»
   * (/admin/reports): обе очереди (рапорта состава и заявки на вступление)
   * открываются вкладками на этой странице.
   */
  const mainNav: NavItem[] = [
    // «Личный кабинет» — первым пунктом: это личное дело бойца (статус службы,
    // «Кто на ВЧ», допуск к технике, свои рапорты), и заходит он сюда чаще
    // всего. Пункт показывается всем, у кого есть действующая сессия: и бойцу
    // (кабинет открыт), и командиру, вошедшему в панель, — вход в панель тоже
    // открывает его личное дело (users.member_id). Гостю пункт не нужен: он вёл
    // бы в заглушку «войдите». Иконка IdCard — «досье», а не шеврон: пункт
    // открывает личное дело, и в списке его не спутать с составом.
    ...(cabinet !== "no_session"
      ? [{ href: "/profile", label: "Личный кабинет", icon: IdCard }]
      : []),
    { href: "/", label: "Обзор", icon: LayoutDashboard },
    { href: "/members", label: "Состав", icon: Users },
    // «Арсенал»: пресеты выкладок для состава. Пункт виден только вошедшему —
    // каталог отдаётся под сессией бойца либо панели, и гостю он был бы тупиком
    { href: "/armory", label: "Арсенал", icon: Crosshair },
    // «Экзамены»: интерактивная шкала нормативов по специальностям подразделения.
    // Пункт виден любому, у кого есть действующая сессия (как «Личный кабинет»):
    // набор специальностей зависит от подразделения бойца, а гость получил бы
    // заглушку — он и так уходит на вход по правилу кабинета.
    ...(cabinet !== "no_session" ? [{ href: "/exams", label: "Экзамены", icon: GraduationCap }] : []),
    // Свои рапорты бойца: подача идёт модальным окном, здесь — история подач
    // со статусами решений штаба. Пункт только для того, у кого есть сессия
    // кабинета: у командира панели без строки бойца страница показала бы
    // заглушку «войдите в личный кабинет», то есть тупик — а его рапорты и
    // решения живут в разделе «Модерация рапортов».
    ...(member ? [{ href: "/reports", label: "Мои рапорты", icon: ScrollText }] : []),
    { href: "/docs", label: "Документация", icon: BookOpen },
  ];

  const staffNav: NavItem[] = [
    { href: "/admin/reports", label: "Модерация рапортов", icon: Inbox },
    { href: "/logs", label: "Журнал", icon: ScrollText },
    { href: "/control", label: "Контроль", icon: ShieldAlert },
    // Настройки — только администратор (то же правило проверяет /api/settings)
    ...(role === "admin" ? [{ href: "/settings", label: "Настройки", icon: Settings2 }] : []),
  ];

  /**
   * Пункты для мобильной панели: только основные разделы, без настроек —
   * на узком экране весь список не помещается.
   */
  const mobileNav = isStaff ? [...mainNav, ...staffNav].filter((i) => i.href !== "/settings") : mainNav;
  const visibleMainNav = mainNav.filter(
    (item) => item.href !== "/armory" || Boolean(member) || role !== "guest",
  );

  /**
   * Кнопка «Подать рапорт» доступна только вошедшему бойцу: рапорт подаётся от
   * своего имени, и без сессии кабинета сервер его отклонит (401). Показывать
   * кнопку гостю значило бы вести его в тупик.
   */
  const canSubmitReport = Boolean(member) && member?.status !== "pending";
  /** Быстрые типы: то, что боец подаёт чаще всего (порядок — как в ТЗ) */
  const quickTypes: readonly ServiceReportType[] = REPORT_TYPE_META.slice(0, 3).map((m) => m.type);

  /** Отрисовка группы пунктов: подсветка активного и общая плашка-подсветка */
  const renderNav = (items: NavItem[]) =>
    items.map((item) => {
      const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
      const Icon = item.icon;
      return (
        <Link key={item.href} href={item.href} className={`nav-link ${active ? "nav-active" : ""}`}>
          {active && <motion.span layoutId="nav-glow" className="nav-glow" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
          <span style={{ position: "relative", zIndex: 1, display: "flex", gap: "0.7rem", alignItems: "center" }}>
            <Icon size={16} style={active ? { color: "var(--red)" } : undefined} />
            {item.label}
          </span>
        </Link>
      );
    });

  if (pathname === "/cookie-bridge") {
    return (
      <>
        <div className="fx-bg fx-grid" />
        <div className="fx-bg fx-glow-red" />
        <div className="fx-bg fx-noise" />
        <div className="relative z-10">{children}</div>
      </>
    );
  }

  return (
    <>
      {/* Фоновое слайд-шоу — поддерживает зацикливание и кроссфейд */}
      <BackgroundSlideshow />
      <div className="fx-bg fx-grid" />
      <div className="fx-bg fx-glow-red" />
      <div className="fx-bg fx-glow-blue" />
      <div className="fx-bg fx-noise" />

      <aside className="sidebar">
        <Link href="/" className="flex items-center gap-4 px-2 pb-8 pt-2">
          {/* Идеально круглый логотип (с жесткой обрезкой) */}
          <div
            className="floaty relative flex items-center justify-center shrink-0 ml-1"
            style={{
              width: 68,
              height: 68,
              boxShadow: "0 0 35px 10px rgba(255,61,61,0.18)",
              borderRadius: "50%",
              overflow: "hidden"
            }}
          >
            <img 
              src="/atk-logo.png" 
              alt="АТК" 
              className="w-full h-full object-cover" 
            />
          </div>
          <div className="flex-1 text-center pr-3">
            <div className="display text-[20px] font-bold tracking-widest text-white">ATK&nbsp;RED</div>
          </div>
        </Link>

        <nav className="flex flex-col gap-3">
          {/* Секция «ОСНОВНОЕ»: ежедневные разделы. Заголовок секции —
              приглушённая надпись, чтобы не спорить с пунктами меню */}
          <div className="flex flex-col gap-1">
            <div className="label px-3 pb-1">Основное</div>
            {renderNav(visibleMainNav)}
          </div>

          {/* Секция «УПРАВЛЕНИЕ»: только штаб — модерация, журнал, контроль, настройки */}
          {isStaff && (
            <div className="flex flex-col gap-1">
              <div className="label px-3 pb-1">Управление</div>
              {renderNav(staffNav)}
            </div>
          )}
        </nav>

        {/*
          Быстрое действие «Подать рапорт».
          
          Раньше это был аккордеон со ссылками /reports/exam, /reports/role и
          т.д. — динамического сегмента у /reports нет, и каждый клик давал 404.
          Теперь кнопка открывает модальное окно поверх текущей страницы, а
          стрелка раскрывает список типов: клик по типу открывает то же окно
          сразу на нужной вкладке (Экзамены / Отпуск / Роль). Переходов нет —
          значит, и 404 взяться неоткуда.
        */}
        {canSubmitReport && (
          <div className="mt-3 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => openReport()}
                className="btn btn-primary"
                style={{ flex: 1, justifyContent: "center" }}
              >
                <FilePlus2 size={15} /> Подать рапорт
              </button>
              <button
                type="button"
                onClick={() => setReportMenuOpen((v) => !v)}
                className="btn btn-sm"
                aria-expanded={reportMenuOpen}
                aria-label={reportMenuOpen ? "Скрыть типы рапортов" : "Показать типы рапортов"}
                style={{ padding: "0.62rem 0.6rem" }}
              >
                <motion.span
                  animate={{ rotate: reportMenuOpen ? 180 : 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 0.8, 0.24, 1] }}
                  style={{ display: "flex" }}
                >
                  <ChevronDown size={15} />
                </motion.span>
              </button>
            </div>

            <AnimatePresence initial={false}>
              {reportMenuOpen && (
                <motion.div
                  key="report-quick-types"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.25, ease: [0.22, 0.8, 0.24, 1] }}
                  style={{ overflow: "hidden" }}
                >
                  <div className="flex flex-col gap-0.5 pt-1 pl-3">
                    {quickTypes.map((type) => {
                      const meta = reportTypeMeta(type);
                      return (
                        <button
                          key={type}
                          type="button"
                          onClick={() => {
                            openReport({ type });
                            setReportMenuOpen(false);
                          }}
                          className="nav-link"
                          style={{ textAlign: "left", cursor: "pointer", fontSize: "0.8rem" }}
                        >
                          <span style={{ position: "relative", zIndex: 1, display: "flex", gap: "0.55rem", alignItems: "center" }}>
                            <span aria-hidden>{meta.icon}</span> {meta.label}
                          </span>
                        </button>
                      );
                    })}
                    {/* Ссылки на страницы из меню убраны совсем: раздел «Мои
                        рапорты» стоит отдельным пунктом в «ОСНОВНОЕ», а здесь
                        остались только запуски модалки — клик по типу рапорта не
                        меняет URL и не может привести на несуществующий адрес */}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}

        {/*
          Подвал сайдбара: одна карточка пользователя и одна кнопка выхода.

          Раньше здесь были две кнопки выхода («Выйти из кабинета» и «Выйти из
          панели») плюс отдельный чип с позывным — у командира, вошедшего
          дважды, подвал занимал четыре строки, и было непонятно, какая кнопка
          что закрывает. Теперь: карточка с позывным (или логином) и статусом,
          в ней же — компактная кнопка выхода, снимающая обе сессии сразу.
        */}
        <div className="mt-4 px-2">
          {member || role !== "guest" ? (
            <div
              className="flex items-center gap-2 rounded-2xl px-3 py-2.5"
              style={{ border: "1px solid var(--stroke-soft)", background: "rgba(255,255,255,0.02)" }}
            >
              <span
                className="flex shrink-0 items-center justify-center"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 10,
                  background: "var(--red-soft)",
                  color: "var(--red)",
                }}
              >
                <UserRound size={15} />
              </span>
              <div className="min-w-0 flex-1">
                {/* Позывной бойца важнее логина панели; у штаба без строки бойца
                    показываем логин, чтобы карточка не осталась безымянной */}
                <div className="truncate text-[12.5px] font-semibold" style={{ color: "var(--text)" }}>
                  {member?.callsign || username || "Учётная запись"}
                </div>
                <div className="truncate text-[10.5px]" style={{ color: "var(--dim)" }}>
                  {member?.statusLabel || (isStaff ? "штаб панели" : "вне строя")}
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogoutAll}
                className="btn btn-sm btn-icon"
                title="Выйти из аккаунта"
                aria-label="Выйти из аккаунта"
                style={{ color: "var(--red)", borderColor: "transparent", background: "rgba(255,61,61,0.1)" }}
              >
                <LogOut size={14} />
              </button>
            </div>
          ) : (
            <Link
              href="/login"
              className="btn btn-sm w-full"
              style={{ background: "rgba(255,255,255,0.05)", borderColor: "transparent", color: "var(--text)" }}
            >
              <LogIn size={14} /> Вход
            </Link>
          )}
        </div>

        <StatusBlock />
      </aside>

      <div className="mobile-bar">
        <Link href="/" className="flex items-center gap-2 pr-2">
          {/* Обрезанный мобильный логотип */}
          <div style={{ width: 28, height: 28, borderRadius: "50%", overflow: "hidden" }}>
            <img src="/atk-logo.png" alt="АТК" className="w-full h-full object-cover" />
          </div>
        </Link>
        {mobileNav.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className="btn btn-sm"
              style={active ? { borderColor: "rgba(255,61,61,.5)", background: "var(--red-soft)", color: "#fff" } : undefined}
            >
              {item.label}
            </Link>
          );
        })}
        {canSubmitReport ? (
          // Кнопка открывает то же модальное окно, что и в сайдбаре: на узком
          // экране сайдбара нет, но подача рапорта обязана остаться доступной
          <button type="button" onClick={() => openReport()} className="btn btn-sm">
            <FilePlus2 size={14} /> Рапорт
          </button>
        ) : null}
        {role === "guest" ? (
          <Link href="/login" className="btn btn-sm"><LogIn size={14} /></Link>
        ) : (
          <button onClick={handleLogoutAll} className="btn btn-sm"><LogOut size={14} /></button>
        )}
      </div>

      <div className="page-wrap">
        <AnimatePresence mode="wait">
          <motion.main key={pathname} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.35, ease: [0.22, 0.8, 0.24, 1] }} className="page-inner">
            {children}
          </motion.main>
        </AnimatePresence>
      </div>
    </>
  );
}
