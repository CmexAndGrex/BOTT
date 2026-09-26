"use client";

/**
 * Карточка комплекта и панель деталей «Арсенала».
 *
 * Разметка вынесена из страницы /armory: страница описывает состояния (фильтры,
 * загрузка, права), а компонент — представление выкладки и копирование строк в
 * игру. Кнопки копирования отдают ровно те значения, которые собраны на сервере
 * (ace_import_string, sqf_code, текстовый табель) — правил форматирования здесь
 * нет, иначе они разошлись бы с API.
 */
import React from "react";
import {
  Check, ClipboardList, Copy, Crosshair, GraduationCap, Package, Radio, ShieldCheck,
  Stethoscope, Terminal, Wrench, X,
} from "lucide-react";
import { ARMORY_DIVISION_META, type ArmoryDivision, type ArmoryEquipment } from "@/lib/armory";

/** Комплект в том виде, в каком его отдаёт GET /api/armory */
export type ArmoryRow = {
  id: number;
  title: string;
  division: ArmoryDivision;
  specialtyCode: string | null;
  description: string | null;
  equipment: ArmoryEquipment;
  aceImportString: string;
  sqfCode: string;
  sqfEden: string;
  checklist: string;
  createdBy: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Цвет акцента раздела: зелёный — танкисты, янтарный — артиллерия, и т.д. */
const ACCENT_COLOR: Record<string, string> = {
  green: "var(--green)",
  amber: "var(--amber)",
  blue: "var(--blue)",
  red: "var(--red)",
};

export function divisionColor(division: ArmoryDivision): string {
  return ACCENT_COLOR[ARMORY_DIVISION_META[division].accent] || "var(--muted)";
}

/** Значок раздела — тот же язык иконок, что и в навигации */
export function DivisionIcon({ division, size = 12 }: { division: ArmoryDivision; size?: number }) {
  if (division === "Танковая рота") return <Wrench size={size} />;
  if (division === "Артиллерийский дивизион") return <Crosshair size={size} />;
  if (division === "Учебная часть") return <GraduationCap size={size} />;
  return <ShieldCheck size={size} />;
}

/** Состояние копирования: какой ключ и с каким итогом отработал */
export type CopyState = { key: string; ok: boolean } | null;

/** Кнопка копирования: зелёная галочка на 1.6 с подтверждает успех */
export function CopyButton({
  label,
  icon: Icon,
  value,
  copyKey,
  state,
  onCopy,
  accent,
}: {
  label: string;
  icon: typeof Copy;
  value: string;
  copyKey: string;
  state: CopyState;
  onCopy: (key: string, value: string) => void;
  accent?: string;
}) {
  const done = state?.key === copyKey && state.ok;
  return (
    <button
      type="button"
      onClick={() => onCopy(copyKey, value)}
      disabled={!value}
      className="btn btn-sm"
      style={
        done
          ? { borderColor: "rgba(61,220,132,.55)", background: "var(--green-soft)", color: "var(--green)" }
          : accent
            ? { borderColor: `${accent}44`, background: `${accent}14`, color: accent }
            : undefined
      }
    >
      {done ? <Check size={14} /> : <Icon size={14} />}
      {done ? "Скопировано" : label}
    </button>
  );
}

/** Карточка каталога: краткая сводка и кнопка раскрытия выкладки */
export function LoadoutCard({ row, onOpen }: { row: ArmoryRow; onOpen: () => void }) {
  const accent = divisionColor(row.division);
  const meta = ARMORY_DIVISION_META[row.division];
  const positions =
    row.equipment.medical.length + row.equipment.magazines.length + row.equipment.misc.length;

  return (
    <article className="card card-hover flex flex-col">
      <div
        className="flex items-start gap-3 border-b px-5 py-4"
        style={{ borderColor: "var(--stroke-soft)" }}
      >
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: `${accent}18`, color: accent, border: `1px solid ${accent}33` }}
        >
          <DivisionIcon division={row.division} size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="display truncate text-[14px] font-bold" title={row.title}>
            {row.title}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className="badge"
              style={{ background: `${accent}18`, color: accent, border: `1px solid ${accent}33` }}
            >
              {meta.short}
            </span>
            {row.specialtyCode && (
              <span className="chip mono" style={{ fontSize: "0.68rem" }} title="Код специальности">
                {row.specialtyCode}
              </span>
            )}
            {!row.isActive && (
              <span className="badge badge-amber" title="Комплект снят с выдачи">
                архив
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-2 px-5 py-4">
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--muted)" }}>
          <Crosshair size={13} style={{ color: accent, flex: "none" }} />
          <span className="truncate" title={row.equipment.primary_weapon || "не выдаётся"}>
            {row.equipment.primary_weapon || "без основного оружия"}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--muted)" }}>
          <ShieldCheck size={13} style={{ color: "var(--dim)", flex: "none" }} />
          <span className="truncate" title={`${row.equipment.uniform} · ${row.equipment.vest}`}>
            {row.equipment.uniform}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[12.5px]" style={{ color: "var(--dim)" }}>
          <Wrench size={13} style={{ flex: "none" }} />
          <span className="truncate" title={row.equipment.vest}>
            {row.equipment.vest}
          </span>
        </div>
        {row.description && (
          <p className="mt-1 text-[12px]" style={{ color: "var(--dim)" }}>
            {row.description.split("\n")[0]}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 px-5 pb-5">
        <button type="button" onClick={onOpen} className="btn btn-sm btn-primary" style={{ flex: 1 }}>
          <ClipboardList size={14} /> Открыть выкладку
        </button>
        <span className="chip mono" style={{ fontSize: "0.68rem" }} title="Позиций в выкладке">
          {positions} поз.
        </span>
      </div>
    </article>
  );
}

/** Строка слота: подпись слева, значение класснейма справа */
function SlotRow({ label, value, accent }: { label: string; value: string | null; accent?: string }) {
  return (
    <div className="flex items-start gap-3 py-2" style={{ borderTop: "1px solid var(--stroke-soft)" }}>
      <span className="label" style={{ minWidth: 118, paddingTop: 2 }}>
        {label}
      </span>
      <span
        className="mono flex-1 text-[12.5px]"
        style={{ color: value ? "var(--text)" : "var(--dim)", wordBreak: "break-word" }}
      >
        {value || "не выдаётся"}
      </span>
    </div>
  );
}

/** Список позиций с количеством: медицина и БК */
function ItemList({
  title,
  icon: Icon,
  items,
  accent,
  empty,
}: {
  title: string;
  icon: typeof Copy;
  items: { name: string; count: number }[];
  accent: string;
  empty: string;
}) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--stroke-soft)" }}>
      <div className="mb-2 flex items-center gap-2">
        <Icon size={14} style={{ color: accent }} />
        <span className="label">{title}</span>
        <span className="chip mono ml-auto" style={{ fontSize: "0.66rem" }}>
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-[12.5px]" style={{ color: "var(--dim)" }}>
          {empty}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((item) => (
            <div key={item.name} className="flex items-baseline gap-2 text-[12.5px]">
              <span className="mono" style={{ color: accent, minWidth: 34 }}>
                ×{item.count}
              </span>
              <span style={{ wordBreak: "break-word" }}>{item.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Список спецсредств: строками, без количеств */
function MiscList({ items, accent }: { items: string[]; accent: string }) {
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--stroke-soft)" }}>
      <div className="mb-2 flex items-center gap-2">
        <Radio size={14} style={{ color: accent }} />
        <span className="label">Спецсредства</span>
        <span className="chip mono ml-auto" style={{ fontSize: "0.66rem" }}>
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-[12.5px]" style={{ color: "var(--dim)" }}>
          Не выдаются
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span key={item} className="chip" style={{ borderColor: `${accent}33` }}>
              <Package size={11} style={{ color: accent }} />
              {item}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
/* ------------------------------------------------------------------ */
/* Панель деталей                                                      */
/* ------------------------------------------------------------------ */

export type DetailTab = "gear" | "weapons" | "medical";

const DETAIL_TABS: { key: DetailTab; label: string; icon: typeof Copy }[] = [
  { key: "gear", label: "Экипировка и СИБЗ", icon: ShieldCheck },
  { key: "weapons", label: "Вооружение и БК", icon: Crosshair },
  { key: "medical", label: "Медицина ACE3 и спецсредства", icon: Stethoscope },
];

/**
 * Выкладка целиком: вкладки по разделам, экспортные строки и копирование.
 *
 * Три кнопки отвечают на три разных сценария бойца: вставить комплект в ACE
 * Arsenal (Ctrl+V в окне арсенала), прогнать массив в Eden и просто прочитать
 * табель. Значения берутся из полей, собранных сервером, — клиент их не собирает,
 * иначе правила форматирования разошлись бы с API.
 */
export function LoadoutDetail({
  row,
  tab,
  onTab,
  copyState,
  onCopy,
  onClose,
  footer,
}: {
  row: ArmoryRow;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
  copyState: CopyState;
  onCopy: (key: string, value: string) => void;
  onClose: () => void;
  footer?: React.ReactNode;
}) {
  const accent = divisionColor(row.division);
  const meta = ARMORY_DIVISION_META[row.division];
  const equipment = row.equipment;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <div
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{ background: `${accent}18`, color: accent, border: `1px solid ${accent}33` }}
        >
          <DivisionIcon division={row.division} size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="display text-[17px] font-bold">{row.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span
              className="badge"
              style={{ background: `${accent}18`, color: accent, border: `1px solid ${accent}33` }}
            >
              {meta.short}
            </span>
            {row.specialtyCode && (
              <span className="chip mono" style={{ fontSize: "0.68rem" }}>
                {row.specialtyCode}
              </span>
            )}
            {!row.isActive && <span className="badge badge-amber">архив</span>}
          </div>
        </div>
        <button type="button" onClick={onClose} className="btn btn-sm btn-icon" aria-label="Закрыть">
          <X size={15} />
        </button>
      </header>

      {row.description && (
        <p
          className="rounded-xl border px-4 py-3 text-[12.5px]"
          style={{ borderColor: "var(--stroke-soft)", color: "var(--muted)", whiteSpace: "pre-wrap" }}
        >
          {row.description}
        </p>
      )}

      {/* Копирование в игру: три сценария — арсенал, Eden, бумажный табель */}
      <div className="flex flex-wrap gap-2">
        <CopyButton
          copyKey="ace"
          label="📋 Скопировать для ACE Arsenal"
          icon={Copy}
          value={row.aceImportString}
          state={copyState}
          onCopy={onCopy}
          accent={accent}
        />
        <CopyButton
          copyKey="sqf"
          label="💻 Скопировать SQF (Eden)"
          icon={Terminal}
          value={row.sqfEden}
          state={copyState}
          onCopy={onCopy}
        />
        <CopyButton
          copyKey="text"
          label="📄 Текстовый табель"
          icon={ClipboardList}
          value={row.checklist}
          state={copyState}
          onCopy={onCopy}
        />
      </div>

      {/* Вкладки разделов выкладки */}
      <div
        className="flex flex-wrap gap-1.5 rounded-xl border p-1"
        style={{ borderColor: "var(--stroke)", background: "rgba(255,255,255,0.02)" }}
      >
        {DETAIL_TABS.map((item) => {
          const Icon = item.icon;
          const active = tab === item.key;
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onTab(item.key)}
              className="chip"
              style={active ? { background: `${accent}18`, borderColor: `${accent}55`, color: accent } : undefined}
            >
              <Icon size={12} />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === "gear" && (
        <div className="rounded-xl border px-4 py-2" style={{ borderColor: "var(--stroke-soft)" }}>
          <SlotRow label="Форма" value={equipment.uniform} />
          <SlotRow label="Разгрузка / бронежилет" value={equipment.vest} />
          <SlotRow label="Шлем" value={equipment.helmet} />
          <SlotRow label="Рюкзак" value={equipment.backpack} />
        </div>
      )}

      {tab === "weapons" && (
        <div className="flex flex-col gap-3">
          <div className="rounded-xl border px-4 py-2" style={{ borderColor: "var(--stroke-soft)" }}>
            <SlotRow label="Основное оружие" value={equipment.primary_weapon} />
            <SlotRow label="Дополнительное" value={equipment.secondary_weapon} />
          </div>
          <ItemList
            title="Магазины и БК"
            icon={Crosshair}
            items={equipment.magazines}
            accent={accent}
            empty="Боекомплект не задан"
          />
        </div>
      )}

      {tab === "medical" && (
        <div className="flex flex-col gap-3">
          <ItemList
            title="Медицина ACE3"
            icon={Stethoscope}
            items={equipment.medical}
            accent={accent}
            empty="Медицина не задана"
          />
          <MiscList items={equipment.misc} accent={accent} />
        </div>
      )}

      {/* Экспортные строки: показываем целиком, они же уходят в буфер обмена */}
      <details className="rounded-xl border p-4" style={{ borderColor: "var(--stroke-soft)" }}>
        <summary className="label" style={{ cursor: "pointer" }}>
          Строка ACE Arsenal (Ctrl+V в окне арсенала)
        </summary>
        <pre
          className="mono mt-3 max-h-40 overflow-auto rounded-lg p-3 text-[11px]"
          style={{
            background: "rgba(8,10,18,.85)",
            color: "var(--muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {row.aceImportString}
        </pre>
      </details>

      <details className="rounded-xl border p-4" style={{ borderColor: "var(--stroke-soft)" }}>
        <summary className="label" style={{ cursor: "pointer" }}>
          SQF для Eden (setUnitLoadout)
        </summary>
        <pre
          className="mono mt-3 max-h-40 overflow-auto rounded-lg p-3 text-[11px]"
          style={{
            background: "rgba(8,10,18,.85)",
            color: "var(--muted)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {row.sqfEden}
        </pre>
      </details>

      {footer}
    </div>
  );
}