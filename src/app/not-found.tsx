/**
 * Дружелюбная страница «адрес не найден».
 *
 * Зачем: любой устаревший адрес (старые ссылки на /reports/exam и подобные)
 * раньше отдавал стандартный белый экран 404 — выглядело как сломанная панель, а
 * не как «страница переехала». Теперь посетитель видит карточку в стиле панели,
 * понимает, что адрес устарел, и уходит на рабочий раздел. Формы подачи рапорта
 * остались в сайдбаре (кнопка «Подать рапорт»), поэтому ничего не потеряно:
 * подача доступна с любой страницы.
 */
import Link from "next/link";
import { Compass, FilePlus2, LayoutDashboard } from "lucide-react";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-md pt-10 text-center">
      <div className="card card-glow-red p-6">
        <Compass size={32} className="mx-auto mb-3" style={{ color: "var(--dim)" }} />
        <div className="eyebrow mb-1">ошибка 404</div>
        <h1 className="display text-lg font-bold mb-1.5">Адрес не найден</h1>
        <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>
          Такой страницы в панели нет. Рапорты подаются кнопкой «Подать рапорт» в сайдбаре —
          переходить на отдельные адреса для этого не нужно.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Link href="/" className="btn btn-primary px-4 py-2">
            <LayoutDashboard size={15} /> На обзор
          </Link>
          <Link href="/reports" className="btn px-4 py-2" style={{ color: "var(--muted)" }}>
            <FilePlus2 size={15} /> Мои рапорты
          </Link>
        </div>
      </div>
    </div>
  );
}