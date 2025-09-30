// src/merge.js
import { db } from './db.js';

/**
 * Возвращает id primary-пользователя для кластера,
 * либо сам id, если кластера нет/primary не найден.
 */
export async function resolvePrimaryUserId(inputId) {
  const id = Number(inputId);
  if (!Number.isFinite(id)) return null;

  // Пример: твоя реальная схема может отличаться.
  // Селекты держим минимальными, чтобы не тянуть поля зря.
  const u = await db.user.findUnique({
    where: { id },
    select: { id: true, cluster_id: true, is_primary: true }
  });
  if (!u) return null;

  if (u.is_primary) return u.id;

  if (u.cluster_id) {
    const primary = await db.user.findFirst({
      where: { cluster_id: u.cluster_id, is_primary: true },
      select: { id: true }
    });
    return primary?.id ?? u.id;
  }
  return u.id;
}
