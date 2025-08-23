import { upsertAndLink, logEvent, readDeviceId, firstIp, userAgent } from '../src/linker.js';

export async function onTelegramAuthSuccess(req, tgData) {
  const deviceId = readDeviceId(req);
  const user = await upsertAndLink({
    provider: 'tg',
    provider_user_id: tgData.id,
    username:   tgData.username || null,
    first_name: tgData.first_name || null,
    last_name:  tgData.last_name  || null,
    avatar_url: tgData.photo_url || null,
    phone_hash: null,
    device_id:  deviceId,
  });
  await logEvent({
    user_id: user.id,
    event_type: 'auth_ok',
    payload: { provider: 'tg' },
    ip: firstIp(req),
    ua: userAgent(req),
  });
  return user;
}

export async function onVkAuthSuccess(req, { userId, profile, token }) {
  const deviceId = req.cookies?.vk_did || readDeviceId(req);
  const user = await upsertAndLink({
    provider: 'vk',
    provider_user_id: userId,
    username:   profile?.screen_name || profile?.preferred_username || null,
    first_name: profile?.first_name  || profile?.given_name || null,
    last_name:  profile?.last_name   || profile?.family_name || null,
    avatar_url: profile?.photo_200   || profile?.picture || null,
    phone_hash: token?.phone || null,
    device_id:  deviceId,
  });
  await logEvent({
    user_id: user.id,
    event_type: 'auth_ok',
    payload: { provider: 'vk' },
    ip: firstIp(req),
    ua: userAgent(req),
  });
  return user;
}
