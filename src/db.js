// src/db.js
// Единая точка доступа к БД через Prisma (PostgreSQL/Neon).
// ESM-версия. Экспортируем singleton-клиент и утилиты.

// Убедись, что в package.json есть:
//   "dependencies": { "@prisma/client": "...", ... },
//   "devDependencies": { "prisma": "..." },
// и скрипт "postinstall": "prisma generate"
// ENV: DATABASE_URL=postgresql://... (Neon)

import { PrismaClient } from '@prisma/client';

let prisma;
/**
 * Делаем singleton, чтобы не плодить коннекты при hot-reload/перезапусках.
 */
if (!globalThis.__PRISMA__) {
  globalThis.__PRISMA__ = new PrismaClient();
}
prisma = globalThis.__PRISMA__;

/**
 * Совместимость с прежним API "pg":
 * query(sql, params) — выполняет сырой SQL (осторожно! проверяй входные данные).
 * Используем $queryRawUnsafe, чтобы поддержать массив params как в pg.
 *
 * Пример:
 *   const rows = await query('SELECT * FROM "User" WHERE vk_id = $1', [vkId]);
 */
export async function query(sql, params = []) {
  // Prisma понимает массив параметров "как есть"
  return prisma.$queryRawUnsafe(sql, ...(params || []));
}

/**
 * Транзакция-обёртка (опционально):
 *   await tx(async (p) => {
 *     await p.user.update({ ... });
 *     await p.transaction.create({ ... });
 *   })
 */
export async function tx(fn) {
  return prisma.$transaction(async (p) => fn(p));
}

/**
 * Корректное закрытие соединения (обычно не нужно на Render, но полезно в тестах).
 */
export async function close() {
  await prisma.$disconnect();
}

// Экспортируем сам клиент (и как default, и по имени)
export { prisma };
export default prisma;
