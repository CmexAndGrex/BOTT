"use client";

/**
 * Форма управления шаблонами «Арсенала» (только штаб).
 *
 * Два способа заполнения, как это реально делают в подразделении:
 *   1. вставить готовый экспорт из игры в поле ACE — тогда строка уезжает в
 *      шаблон дословно, и пересобирать её руками не нужно;
 *   2. заполнить слоты выкладки — тогда из них собирается SQF для Eden, а
 *      ACE-строка всё равно вставляется экспортом: корректный формат знает
 *      только игра, и выдумывать его нельзя (панель отвечает за проверку, а не
 *      за генерацию выкладки).
 *
 * Проверка на клиенте идёт теми же валидаторами, что и на сервере
 * (validateEquipment / validateAceImportString / validateSqfArray): форма
 * показывает требование сразу, а формулировки совпадают с ответом API.
 */
import React, { useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import {
  ARMORY_DIVISIONS,
  ARMORY_ITEM_COUNT_MAX,
  emptyEquipment,
  sqfForEden,
  sqfStringArray,
  validateAceImportString,
  validateEquipment,
  validateSqfArray,
  type ArmoryDivision,
  type ArmoryEquipment,
  type ArmoryItem,
} from "@/lib/armory";
import type { ArmoryRow } from "@/components/armory-loadout";

export type ArmoryDraft = {
  id: number | null;
  title: string;
  division: ArmoryDivision;
  specialtyCode: string;
  description: string;
  equipment: ArmoryEquipment;
  aceImportString: string;
  sqfCode: string;
  isActive: boolean;
};

/** Черновик из существующего шаблона либо пустой — для нового комплекта */
export function draftFrom(row: ArmoryRow | null): ArmoryDraft {
  if (!row) {
    return {
      id: null,
      title: "",
      division: "Общий",
      specialtyCode: "",
      description: "",
      equipment: emptyEquipment(),
      aceImportString: "",
      sqfCode: "",
      isActive: true,
    };
  }
  return {
    id: row.id,
    title: row.title,
    division: row.division,
    specialtyCode: row.specialtyCode || "",
    description: row.description || "",
    equipment: row.equipment,
    aceImportString: row.aceImportString,
    sqfCode: row.sqfCode,
    isActive: row.isActive,
  };
}

/** Поле формы с подписью и подсказкой */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="label">{label}</span>
      {children}
      {hint && (
        <span className="text-[11.5px]" style={{ color: "var(--dim)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

/** Редактор списка позиций с количеством: медицина и БК */
function ItemsEditor({
  label,
  items,
  onChange,
  placeholder,
}: {
  label: string;
  items: ArmoryItem[];
  onChange: (items: ArmoryItem[]) => void;
  placeholder: string;
}) {
  const update = (index: number, patch: Partial<ArmoryItem>) => {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="label">{label}</span>
      {items.map((item, index) => (
        <div key={`${label}-${index}`} className="flex items-center gap-2">
          <input
            className="input input-mono"
            style={{ flex: 1 }}
            value={item.name}
            placeholder={placeholder}
            onChange={(e) => update(index, { name: e.target.value })}
          />
          <input
            className="input mono"
            style={{ width: 86 }}
            type="number"
            min={1}
            max={ARMORY_ITEM_COUNT_MAX}
            value={item.count}
            onChange={(e) => update(index, { count: Number(e.target.value) })}
          />
          <button
            type="button"
            className="btn btn-sm btn-icon"
            onClick={() => onChange(items.filter((_, i) => i !== index))}
            aria-label="Удалить позицию"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn btn-sm"
        style={{ alignSelf: "flex-start" }}
        onClick={() => onChange([...items, { name: "", count: 1 }])}
      >
        <Plus size={14} /> Добавить позицию
      </button>
    </div>
  );
}

/** Редактор простого списка строк: спецсредства */
function MiscEditor({
  items,
  onChange,
}: {
  items: string[];
  onChange: (items: string[]) => void;
}) {
  const [value, setValue] = useState("");

  const add = () => {
    const text = value.trim();
    if (!text || items.includes(text)) return;
    onChange([...items, text]);
    setValue("");
  };

  return (
    <div className="flex flex-col gap-2">
      <span className="label">Спецсредства (Radio, NVG, GPS, Watch, Map, Binoculars)</span>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, index) => (
            <span key={item} className="chip">
              {item}
              <button
                type="button"
                onClick={() => onChange(items.filter((_, i) => i !== index))}
                aria-label={`Убрать ${item}`}
                style={{
                  background: "none",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  display: "flex",
                  padding: 0,
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          className="input input-mono"
          style={{ flex: 1 }}
          value={value}
          placeholder="Например: Radio"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            add();
          }}
        />
        <button type="button" className="btn btn-sm" onClick={add}>
          <Plus size={14} /> Добавить
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Форма шаблона                                                       */
/* ------------------------------------------------------------------ */

export type ArmoryAdminProps = {
  draft: ArmoryDraft;
  onChange: (draft: ArmoryDraft) => void;
  onSave: () => void;
  onArchive: () => void;
  onReset: () => void;
  busy: boolean;
  error: string;
};

/**
 * Сборка SQF из заполненных слотов.
 *
 * Это НЕ выкладка BI: порядок и состав её массива знает только игра, и собирать
 * его «на глаз» нельзя. Формируется корректная по синтаксису заготовка — строка
 * экипировки (форма, разгрузка, рюкзак, шлем) и списки класснеймов в
 * комментариях. Офицер заменяет их настоящими значениями, а готовую выкладку
 * присылает экспортом из игры в поле ACE Arsenal.
 */
export function buildSqfSkeleton(draft: ArmoryDraft): string {
  const gear = sqfStringArray([
    draft.equipment.uniform || "",
    draft.equipment.vest || "",
    draft.equipment.backpack,
    draft.equipment.helmet || "",
  ]);
  const weapons = sqfStringArray([
    draft.equipment.primary_weapon,
    draft.equipment.secondary_weapon,
  ]);
  const magazines = sqfStringArray(draft.equipment.magazines.map((item) => item.name));
  const medical = sqfStringArray(draft.equipment.medical.map((item) => item.name));

  return [
    sqfForEden(gear),
    `// Вооружение: ${weapons}`,
    `// БК: ${magazines}`,
    `// Медицина: ${medical}`,
    "// Готовая выкладка принимается экспортом из ACE Arsenal (Ctrl+C) — дословно",
  ].join("\n");
}

/**
 * Форма шаблона: поля карточки, слоты выкладки и две экспортные строки.
 *
 * Проверка на клиенте идёт теми же валидаторами, что и на сервере: форма
 * показывает требование сразу (до запроса), а формулировки ошибок совпадают с
 * ответом API — офицер не читает два разных текста об одном и том же.
 */
export function ArmoryAdminForm({
  draft,
  onChange,
  onSave,
  onArchive,
  onReset,
  busy,
  error,
}: ArmoryAdminProps) {
  const [localError, setLocalError] = useState("");

  const patch = (part: Partial<ArmoryDraft>) => onChange({ ...draft, ...part });
  const patchEquipment = (part: Partial<ArmoryEquipment>) =>
    onChange({ ...draft, equipment: { ...draft.equipment, ...part } });

  /** Предварительная проверка: тот же валидатор, что и в API */
  const handleSave = () => {
    setLocalError("");
    const equipment = validateEquipment(draft.equipment);
    if (!equipment.ok) {
      setLocalError(equipment.error);
      return;
    }
    const ace = validateAceImportString(draft.aceImportString);
    if (!ace.ok) {
      setLocalError(ace.error);
      return;
    }
    const sqf = validateSqfArray(draft.sqfCode);
    if (!sqf.ok) {
      setLocalError(sqf.error);
      return;
    }
    onSave();
  };

  const message = localError || error;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Название комплекта" hint="Например: «Механик-водитель Т-90А»">
          <input
            className="input"
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value })}
            placeholder="Механик-водитель Т-90А"
          />
        </Field>
        <Field label="Подразделение">
          <select
            className="select"
            value={draft.division}
            onChange={(e) => patch({ division: e.target.value as ArmoryDivision })}
          >
            {ARMORY_DIVISIONS.map((division) => (
              <option key={division} value={division}>
                {division}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Код специальности" hint="Внутренний код / MOS, необязательно">
          <input
            className="input input-mono"
            value={draft.specialtyCode}
            onChange={(e) => patch({ specialtyCode: e.target.value })}
            placeholder="МВ-Т90А"
          />
        </Field>
        <Field label="Состояние" hint="Архив — комплект скрыт из каталога, но не удалён">
          <select
            className="select"
            value={draft.isActive ? "active" : "archived"}
            onChange={(e) => patch({ isActive: e.target.value === "active" })}
          >
            <option value="active">Действует</option>
            <option value="archived">В архиве</option>
          </select>
        </Field>
      </div>

      <Field label="Тактическое пояснение" hint="Допуски, требования, порядок выдачи">
        <textarea
          className="textarea"
          value={draft.description}
          onChange={(e) => patch({ description: e.target.value })}
          placeholder="Требуется допуск КМБТ. Выдаётся командиром роты перед выездом."
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Форма (uniform)">
          <input
            className="input input-mono"
            value={draft.equipment.uniform}
            onChange={(e) => patchEquipment({ uniform: e.target.value })}
            placeholder="rhs_uniform_6b45"
          />
        </Field>
        <Field label="Разгрузка / бронежилет (vest)">
          <input
            className="input input-mono"
            value={draft.equipment.vest}
            onChange={(e) => patchEquipment({ vest: e.target.value })}
            placeholder="rhs_6b45_rifleman"
          />
        </Field>
        <Field label="Шлем (helmet)">
          <input
            className="input input-mono"
            value={draft.equipment.helmet}
            onChange={(e) => patchEquipment({ helmet: e.target.value })}
            placeholder="rhs_6b47"
          />
        </Field>
        <Field label="Рюкзак (backpack)" hint="Пусто — рюкзак не выдаётся">
          <input
            className="input input-mono"
            value={draft.equipment.backpack || ""}
            onChange={(e) => patchEquipment({ backpack: e.target.value })}
            placeholder="rhs_tortila_black"
          />
        </Field>
        <Field label="Основное оружие (primary_weapon)">
          <input
            className="input input-mono"
            value={draft.equipment.primary_weapon || ""}
            onChange={(e) => patchEquipment({ primary_weapon: e.target.value })}
            placeholder="rhs_weap_ak74m"
          />
        </Field>
        <Field label="Дополнительное (secondary_weapon)">
          <input
            className="input input-mono"
            value={draft.equipment.secondary_weapon || ""}
            onChange={(e) => patchEquipment({ secondary_weapon: e.target.value })}
            placeholder="rhs_weap_rpg26"
          />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <ItemsEditor
          label="Медицина ACE3"
          items={draft.equipment.medical}
          placeholder="ACE_fieldDressing"
          onChange={(medical) => patchEquipment({ medical })}
        />
        <ItemsEditor
          label="Магазины и БК"
          items={draft.equipment.magazines}
          placeholder="rhs_30Rnd_545x39_AK"
          onChange={(magazines) => patchEquipment({ magazines })}
        />
      </div>

      <MiscEditor items={draft.equipment.misc} onChange={(misc) => patchEquipment({ misc })} />

      <Field
        label="Строка ACE Arsenal"
        hint="Вставьте экспорт из игры: в ACE Arsenal выделите выкладку и нажмите Ctrl+C"
      >
        <textarea
          className="textarea input-mono"
          value={draft.aceImportString}
          onChange={(e) => patch({ aceImportString: e.target.value })}
          placeholder='["rhs_uniform_6b45", ["ACE_fieldDressing", 5]]'
        />
      </Field>

      <Field
        label="SQF для Eden (setUnitLoadout)"
        hint="«Голый» массив или готовый код с оператором"
      >
        <textarea
          className="textarea input-mono"
          value={draft.sqfCode}
          onChange={(e) => patch({ sqfCode: e.target.value })}
          placeholder="player setUnitLoadout [...]"
        />
      </Field>

      {message && (
        <p
          className="card px-4 py-3 text-[12.5px]"
          style={{ borderColor: "rgba(255,61,61,.45)", color: "var(--red)" }}
        >
          {message}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm btn-primary" onClick={handleSave} disabled={busy}>
          {draft.id === null ? "Создать шаблон" : "Сохранить изменения"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => patch({ sqfCode: buildSqfSkeleton(draft) })}
        >
          Собрать заготовку SQF
        </button>
        {draft.id !== null && (
          <button type="button" className="btn btn-sm" onClick={onArchive} disabled={busy}>
            <Trash2 size={14} /> {draft.isActive ? "В архив" : "Вернуть из архива"}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onReset}>
          Сбросить форму
        </button>
      </div>
    </div>
  );
}