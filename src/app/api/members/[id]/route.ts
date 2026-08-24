import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { members } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const memberId = parseInt(id, 10);
  if (!Number.isFinite(memberId)) {
    return NextResponse.json({ ok: false, error: "Некорректный ID" }, { status: 400 });
  }

  let body: { vacation?: boolean; discordId?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Некорректный JSON" }, { status: 400 });
  }

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof body.vacation === "boolean") set.vacation = body.vacation;
  if (body.discordId !== undefined) {
    const v = body.discordId;
    set.discordId =
      v === null || String(v).trim() === "" ? null : String(v).replace(/[^\d]/g, "") || null;
  }

  const rows = await db
    .update(members)
    .set(set)
    .where(eq(members.id, memberId))
    .returning();

  if (!rows.length) {
    return NextResponse.json({ ok: false, error: "Боец не найден" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, member: rows[0] });
}
