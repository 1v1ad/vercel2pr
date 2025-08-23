// One-liner bootstrap to mount routes without rewriting your server
import makeVkStartRouter from './routes/vk_start_router.js';
import makeEventsRouter from './src/events.js';

export function mountLinkMerge(app) {
  // Mount VK start endpoint
  app.use('/api/auth/vk', makeVkStartRouter());
  // Optional: events endpoint for admin metrics
  // app.use('/api/events', makeEventsRouter());
}
