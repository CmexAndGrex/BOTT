/**
 * Совместимость со старыми адресами подачи рапорта: /reports/exam, /reports/role…
 *
 * Тип рапорта раньше жил в пути, и такие ссылки успели разойтись по закладкам и
 * переписке. Сам динамический сегмент теперь не нужен — тип передаётся
 * query-параметром (/reports?type=exam), поэтому страница ничего не рисует, а
 * сразу перенаправляет на рабочий адрес. Без этого файла старые ссылки
 * упирались бы в 404 — ровно та жалоба, из-за которой раздел переделан.
 */
import { redirect } from "next/navigation";
import { REPORT_TYPE_META, isServiceReportType } from "@/lib/reports";

export default async function LegacyReportTypePage({
  params,
}: {
  params: Promise<{ type: string }>;
}) {
  const { type } = await params;
  const known = isServiceReportType(type) && REPORT_TYPE_META.some((m) => m.type === type);
  redirect(known ? `/reports?type=${type}` : "/reports");
}