"use client";

/**
 * Поля вкладок настроек: сетка, подпись с подсказкой и секретное поле.
 *
 * Здесь собрано то, что повторялось на странице десятками копий. Раньше каждый
 * ID канала был отдельным вертикальным блоком во всю ширину карточки: пять
 * подряд — и на экран помещалось полтора поля, хотя это однотипные короткие
 * числа. Теперь такие поля идут в адаптивной сетке по два в ряд.
 */
import { useState } from "react";
import { KeyRound, Pencil, X } from "lucide-react";
import { Toggle } from "@/components/ui";

/**
 * Сетка однотипных полей.
 *
 * Два столбца включаются с sm: на телефоне одна колонка читается лучше, а на
 * узком экране две подписи вида «ID канала заявок на вступление» обрезались бы
 * до нечитаемого.
 */
export function FieldGrid({
  children,
  columns = 2,
}: {
  children: React.ReactNode;
  /** Колонок на широком экране; 3 — для коротких числовых полей */
  columns?: 2 | 3;
}) {
  const cols = columns === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2";
  return <div className={`grid grid-cols-1 gap-3 ${cols}`}>{children}</div>;
}

/**
 * Одно поле: подпись, элемент ввода и подсказка.
 *
 * `hint` — обычная подсказка под полем. `alignTop` прижимает подписи к низу
 * блока: в сетке подсказки разной высоты иначе разъезжаются, и «ID канала»
 * соседа оказывается на другой высоте, чем у поля рядом.
 */
export function Field({
  label,
  hint,
  children,
  mono,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  /** Подсказка моноширинным шрифтом: для примеров значений и путей */
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="label mb-1.5">{label}</div>
      {children}
      {hint && (
        <p
          className={`mt-1.5 text-[11.5px] leading-relaxed ${mono ? "mono" : ""}`}
          style={{ color: "var(--dim)" }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Переключатель с подписью в строке: «вкл · Фоновая сверка ролей».
 *
 * Повторялся в каждой задаче планировщика — пять одинаковых блоков разметки.
 */
export function ToggleRow({
  label,
  title,
  on,
  onChange,
}: {
  /** Служебная подпись слева (например «вкл») */
  label?: string;
  title: React.ReactNode;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      {label && <span className="label">{label}</span>}
      <Toggle on={on} onChange={onChange} />
      <span className="text-[12.5px]">{title}</span>
    </div>
  );
}

/**
 * Секрет под спойлером: паспорт сервисного аккаунта Google (JSON).
 *
 * Зачем так. Это единственное поле в интерфейсе, куда вставляют многострочный
 * приватный ключ, и держать его развёрнутым на всю карточку было вредно: JSON
 * занимал пол-экрана, ломал ритм сетки и провоцировал правки «руками», хотя
 * ключ меняют в Google Cloud и вставляют целиком. По умолчанию показываем
 * компактный бейдж «Ключ загружен» и кнопку «Заменить ключ»; текстовое поле
 * раскрывается только по нажатию.
 *
 * ВАЖНО про API: роут отдаёт секрет замаскированным, а PUT игнорирует значение
 * с «••» (см. SECRET_KEYS в api/settings/route.ts). Поэтому «не трогали поле» и
 * «очистили поле» — разные состояния, и мы их не смешиваем:
 *   * `value` с маской уходит обратно как есть — ключ остаётся прежним;
 *   * пустая строка отправляется явно — ключ удаляется.
 */
export function SecretKeyField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: React.ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  /** Значение из API приходит с маской или пустым: это признак «ключ задан» */
  const stored = value.trim();
  const masked = stored.includes("••");
  const loaded = stored.length > 0;

  /** Открываем редактор: в поле пусто — старая маска не должна «утекать» в текст */
  const startEdit = () => {
    setDraft("");
    setEditing(true);
  };

  const cancel = () => {
    setDraft("");
    setEditing(false);
  };

  const apply = () => {
    const next = draft.trim();
    // Пустое поле при сохранении = осознанное удаление ключа, поэтому пишем "".
    onChange(next);
    setEditing(false);
  };

  if (!editing) {
    return (
      <div className="flex min-w-0 flex-col">
        <div className="label mb-1.5">{label}</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={loaded ? "badge badge-green" : "badge badge-amber"}>
            <KeyRound size={11} className="mr-1 inline" />
            {loaded ? "Ключ загружен" : "Ключ не задан"}
          </span>
          {loaded && masked && (
            <span className="mono text-[11.5px]" style={{ color: "var(--dim)" }}>
              {stored}
            </span>
          )}
          <button type="button" className="btn btn-sm" onClick={startEdit}>
            {loaded ? <Pencil size={13} /> : <KeyRound size={13} />}
            {loaded ? "Заменить ключ" : "Загрузить ключ"}
          </button>
        </div>
        {hint && (
          <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
            {hint}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="label">{label}</div>
        <button type="button" className="btn btn-sm btn-icon" onClick={cancel} title="Отменить замену">
          <X size={13} />
        </button>
      </div>
      <textarea
        className="textarea"
        style={{ minHeight: 110 }}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        autoFocus
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm btn-primary" onClick={apply}>
          Применить ключ
        </button>
        <button type="button" className="btn btn-sm" onClick={cancel}>
          Отмена
        </button>
        <span className="text-[11.5px]" style={{ color: "var(--dim)" }}>
          Новый ключ применится после кнопки «Сохранить всё».
        </span>
      </div>
      {hint && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: "var(--dim)" }}>
          {hint}
        </p>
      )}
    </div>
  );
}