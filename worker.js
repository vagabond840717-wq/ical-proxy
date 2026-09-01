const ALLOWED = [
  'airbnb.com','www.airbnb.com','airbnb.co.kr','www.airbnb.co.kr',
  'booking.com','www.booking.com','agoda.com',
  'jnjhana.netlify.app','jnjhana.pages.dev',
  'ebooking.ctrip.com','secure.booking.com',
  'ical.livn.kr','www.livn.kr','booking.vagabond1984.workers.dev',
  'vagabond840717-wq.github.io'
]

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(request) });
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/rooms' && request.method === 'POST') {
      await env.HANA_KV.put('rooms', JSON.stringify(await request.json()));
      return json({ ok: true }, request);
    }
    if (path === '/rooms' && request.method === 'GET') {
      const data = await env.HANA_KV.get('rooms');
      return new Response(data || '[]', { headers: { 'Content-Type': 'application/json', ...cors(request) } });
    }
    if (path === '/extra' && request.method === 'POST') {
      const body = await request.json();
      if (!body.key) return json({ error: 'key 없음' }, request, 400);
      await env.HANA_KV.put('extra_' + body.key, JSON.stringify(body.data));
      return json({ ok: true }, request);
    }
    if (path === '/extra' && request.method === 'GET') {
      const key = url.searchParams.get('key');
      if (!key) return new Response('{"passwords":[],"memos":[]}', { headers: { 'Content-Type': 'application/json', ...cors(request) } });
      const data = await env.HANA_KV.get('extra_' + key);
      return new Response(data || '{"passwords":[],"memos":[]}', { headers: { 'Content-Type': 'application/json', ...cors(request) } });
    }
    if (path === '/sync' && request.method === 'POST') {
      const result = await syncAllRooms(env);
      return json({ ok: true, synced: result.synced, time: result.time }, request);
    }
    if (path === '/bookings' && request.method === 'GET') {
      const data = await env.HANA_KV.get('synced_bookings');
      // 화면용 — 트립 당일잠금 가짜 블락을 걷어내고 준다. KV 원본과 내보내기는 그대로 (05-known-issues #28)
      try {
        const fixed = applyDaylock(JSON.parse(data || '{}'), await readDaylock(env));
        return new Response(JSON.stringify(fixed), { headers: { 'Content-Type': 'application/json', ...cors(request) } });
      } catch (e) {
        return new Response(data || '{}', { headers: { 'Content-Type': 'application/json', ...cors(request) } });
      }
    }
    // 트립 당일잠금 판정 상태 — 진단용 읽기 전용
    if (path === '/daylock' && request.method === 'GET') {
      return json(await readDaylock(env), request);
    }
    // 소급 청소 (1회성). ?dry=1 이면 무엇을 바꿀지 보여주기만 하고 쓰지 않는다.
    if (path === '/daylock/backfill' && request.method === 'POST') {
      return json(await backfillDaylock(env, url.searchParams.get('dry') === '1'), request);
    }
    if (path === '/archive' && request.method === 'GET') {
      const data = await env.HANA_KV.get('booking_archive');
      return new Response(data || '{}', { headers: { 'Content-Type': 'application/json', ...cors(request) } });
    }
    if (path === '/push/subscribe' && request.method === 'POST') {
      const sub = await request.json();
      const key = 'sub_' + btoa(sub.endpoint).slice(0, 40).replace(/[+/=]/g, '');
      await env.PUSH_KV.put(key, JSON.stringify(sub));
      return json({ ok: true }, request);
    }
    if (path === '/push/unsubscribe' && request.method === 'POST') {
      const { endpoint } = await request.json();
      const key = 'sub_' + btoa(endpoint).slice(0, 40).replace(/[+/=]/g, '');
      await env.PUSH_KV.delete(key);
      return json({ ok: true }, request);
    }
    // 알림 이벤트 목록
    if (path === '/push/events' && request.method === 'GET') {
      const data = await env.PUSH_KV.get('events');
      return new Response(data || '[]', { headers: { 'Content-Type': 'application/json', ...cors(request) } });
    }
    // 전체 읽음 처리
    if (path === '/push/events/readall' && request.method === 'POST') {
      const raw = await env.PUSH_KV.get('events');
      const events = raw ? JSON.parse(raw) : [];
      const updated = events.map(e => ({ ...e, read: true }));
      await env.PUSH_KV.put('events', JSON.stringify(updated));
      return json({ ok: true }, request);
    }
    // 이벤트 읽음 처리
    if (path === '/push/events/read' && request.method === 'POST') {
      const { id } = await request.json();
      const raw = await env.PUSH_KV.get('events');
      const events = raw ? JSON.parse(raw) : [];
      const updated = events.map(e => e.id === id ? { ...e, read: true } : e);
      await env.PUSH_KV.put('events', JSON.stringify(updated));
      return json({ ok: true }, request);
    }
    if (path === '/push/test' && request.method === 'POST') {
      const results = [];
      const keys = await env.PUSH_KV.list({ prefix: 'sub_' });
      for (const k of keys.keys) {
        const subJson = await env.PUSH_KV.get(k.name);
        if (!subJson) continue;
        try {
          const status = await sendWebPush(env, JSON.parse(subJson), { title: '🔔 테스트 알림', body: 'HANA STAY 푸시 알림 정상 작동!' });
          results.push({ key: k.name.slice(0, 20), status });
          if (status === 410 || status === 404) await env.PUSH_KV.delete(k.name);
        } catch (e) {
          results.push({ key: k.name.slice(0, 20), error: e.message });
        }
      }
      await saveEvent(env, { type: 'test', room: '테스트', platform: 'HANA STAY', ts: Date.now() });
      return json({ ok: true, results }, request);
    }
    // /ical/<호실명>        → 네 플랫폼 전부 (레거시. 동작 불변)
    // /ical/<호실명>/<채널>  → 그 채널 자기 예약만 빼고 (ab|bk|tr|lv)
    // 마지막 조각이 알려진 채널 키일 때만 채널로 해석 → 호실명에 영향 없음
    if (path.startsWith('/ical/')) {
      const rest = decodeURIComponent(path.slice('/ical/'.length));
      const cut = rest.lastIndexOf('/');
      let roomName = rest, target = null;
      if (cut > 0) {
        const tail = rest.slice(cut + 1);
        if (EXPORT_TARGETS.includes(tail)) { target = tail; roomName = rest.slice(0, cut); }
      }
      return await exportIcal(env, roomName, target);
    }
    const icalUrl = url.searchParams.get('url');
    if (!icalUrl) return json({ error: 'url 파라미터 없음' }, request, 400);
    const fetchUrl = icalUrl.replace(/^webcal:\/\//i, 'https://');
    try {
      const hostname = new URL(fetchUrl).hostname;
      if (!ALLOWED.some(d => hostname === d || hostname.endsWith('.' + d))) return json({ error: '허용되지 않은 도메인' }, request, 403);
      const resp = await fetch(fetchUrl);
      let text = await resp.text();
      // fix=tr&room=<호실> 옵트인 — 청소앱 전용. 트립 당일잠금 가짜 블락을 걷어낸 판을 준다.
      // ⚠ 파라미터가 없으면 원본 바이트 그대로. #28 판별 순서 1번("원본을 받아 대조")을 오염시키면 안 된다.
      //   교정할 게 없어도 원본 그대로 — 재생성조차 하지 않는다.
      if (url.searchParams.get('fix') === 'tr' && hostname.endsWith('ctrip.com')) {
        try { text = await fixTripIcalText(env, text, url.searchParams.get('room')); } catch (e) {}
      }
      return new Response(text, { headers: { 'Content-Type': 'text/calendar', ...cors(request) } });
    } catch (e) { return json({ error: e.message }, request, 500); }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAllRooms(env, true));
  }
};

// ── Web Push RFC 8291 (aes128gcm) ──
async function sendWebPush(env, sub, payload) {
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  const p256dh = b64ToBytes(sub.keys.p256dh);
  const auth   = b64ToBytes(sub.keys.auth);

  const serverKP = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', serverKP.publicKey));

  const clientPub = await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

  const ecdhBits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPub }, serverKP.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const ikmInfo = concat(te('WebPush: info\0'), p256dh, serverPubRaw);
  const ikm = await hkdf(auth, ecdhBits, ikmInfo, 32);

  const cek   = await hkdf(salt, ikm, te('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, te('Content-Encoding: nonce\0'), 12);

  const padded = concat(plaintext, new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cekKey, padded));

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = 65;
  header.set(serverPubRaw, 21);

  const body = concat(header, ciphertext);

  const vapid = await makeVapid(env, sub.endpoint);

  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Authorization': vapid,
      'TTL': '86400',
    },
    body
  });
  return res.status;
}

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

async function makeVapid(env, endpoint) {
  const origin = new URL(endpoint).origin;
  const b64 = o => btoa(JSON.stringify(o)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
  const unsigned = b64({ typ: 'JWT', alg: 'ES256' }) + '.' + b64({ aud: origin, exp: Math.floor(Date.now()/1000) + 43200, sub: env.VAPID_SUBJECT });
  const raw = b64ToBytes(env.VAPID_PRIVATE_KEY);
  const pkcs8 = new Uint8Array([
    0x30,0x41,0x02,0x01,0x00,0x30,0x13,
    0x06,0x07,0x2a,0x86,0x48,0xce,0x3d,0x02,0x01,
    0x06,0x08,0x2a,0x86,0x48,0xce,0x3d,0x03,0x01,0x07,
    0x04,0x27,0x30,0x25,0x02,0x01,0x01,0x04,0x20,
    ...raw
  ]);
  const privKey = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = bytesToB64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privKey, te(unsigned))));
  return `vapid t=${unsigned}.${sig}, k=${env.VAPID_PUBLIC_KEY}`;
}

const te = s => new TextEncoder().encode(s);
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0));
  let i = 0; for (const a of arrays) { out.set(a, i); i += a.length; } return out;
}
function b64ToBytes(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  return Uint8Array.from(atob((b64 + pad).replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
}
function bytesToB64(arr) {
  return btoa(String.fromCharCode(...arr)).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
}

// ── 동기화 ──
async function syncAllRooms(env, withPush = false) {
  const roomsRaw = await env.HANA_KV.get('rooms');
  if (!roomsRaw) return { synced: 0, time: new Date().toISOString() };
  const rooms = JSON.parse(roomsRaw);
  const synced_bookings = {};
  const prevSyncedRaw = await env.HANA_KV.get('synced_bookings') || '{}';
  const prevSynced = JSON.parse(prevSyncedRaw);
  const prevArchiveRaw = await env.HANA_KV.get('booking_archive') || '{}';
  const prevArchive = JSON.parse(prevArchiveRaw);
  const newArchive = {};
  const prevUidsRaw = withPush ? (await env.PUSH_KV.get('last_booking_uids') || '{}') : '{}';
  const prev = withPush ? JSON.parse(prevUidsRaw) : {};
  const curr = {};
  // 복구 감지용: 루프 시작 전 현재 미확인 오류 이벤트 목록을 1회 로드
  const cachedEvents = withPush ? JSON.parse(await env.PUSH_KV.get('events') || '[]') : [];
  const recoveryActions = []; // { room, platform } — 루프 후 일괄 처리
  // 병렬 처리 결과를 호실 배열 순서대로 모아두고, 루프가 끝난 뒤 고정된 순서로 합친다
  // (Promise.all 완료 순서는 매번 달라서, 그 순서로 바로 객체에 써넣으면 키 순서가 흔들려
  //  내용이 같아도 JSON 문자열이 달라져 불필요한 KV 쓰기가 발생함)
  const roomResults = await Promise.all(rooms.map(async (room) => {
    const prevRoomData = prevSynced[room.name] || {};
    const bookings = {
      ab: prevRoomData.ab || [],
      bk: prevRoomData.bk || [],
      tr: prevRoomData.tr || [],
      lv: prevRoomData.lv || [],
    };
    newArchive[room.name] = { ab: [], bk: [], tr: [], lv: [] };
    const roomCurr = {};
    const platforms = [
      { key: 'ab', url: room.url,   label: 'Airbnb',      type: 'airbnb'  },
      { key: 'bk', url: room.bkUrl, label: 'Booking.com', type: 'booking' },
      { key: 'tr', url: room.trUrl, label: 'Trip.com',    type: 'trip'    },
      { key: 'lv', url: room.lvUrl, label: '리브애니웨어', type: 'lv'      },
    ];
    for (const p of platforms) {
      if (!p.url) continue;
      const result = await fetchAndParseIcal(p.url, p.type);
      if (result === null) {
        if (withPush) {
          // 오류 시 curr에 저장하지 않음 — prev 값은 저장 시 merge로 유지
          const failKey = `fail_${room.name}_${p.key}`;
          const failCount = parseInt(await env.PUSH_KV.get(failKey) || '0') + 1;
          await env.PUSH_KV.put(failKey, String(failCount));
          if (failCount === 3) {
            const msg = { title: `⚠️ ${room.name} 연결 오류`, body: `${p.label} iCal 연결이 15분째 실패 중이에요.`, room: room.name };
            await sendPushToAll(env, msg);
            await saveEvent(env, { type: 'error', room: room.name, platform: p.label, cin: '', cout: '', ts: Date.now() });
          }
        }
        continue;
      }
      if (withPush) {
        const failKey = `fail_${room.name}_${p.key}`;
        // 복구 감지: 이번 성공 전에 미확인 오류 알림이 있었으면 복구 처리 예약
        const hadError = cachedEvents.some(e => e.type === 'error' && !e.read && e.room === room.name && e.platform === p.label);
        if (hadError) recoveryActions.push({ room: room.name, platform: p.label });
        // 목록 전체를 훑어보는(list) 대신, 그 키 하나만 콕 찍어 확인(get) → 나열 한도 대신 여유로운 읽기 한도 사용
        if (await env.PUSH_KV.get(failKey) !== null) await env.PUSH_KV.delete(failKey);
      }
      bookings[p.key] = result;
      newArchive[room.name][p.key] = result;
      if (withPush) {
        const bookingMap = {};
        result.filter(b => !b.summary?.toLowerCase().includes('not available')).forEach(b => {
          const uid = `${b.cinY}_${b.cinM}_${b.cinD}_${b.coutY}_${b.coutM}_${b.coutD}`;
          const cin  = `${b.cinY}/${String(b.cinM+1).padStart(2,'0')}/${String(b.cinD).padStart(2,'0')}`;
          const cout = `${b.coutY}/${String(b.coutM+1).padStart(2,'0')}/${String(b.coutD).padStart(2,'0')}`;
          bookingMap[uid] = { ...b, cin, cout };
        });
        const uids = Object.keys(bookingMap);
        const prevData = prev[room.name + '_' + p.key] || {};
        const prevUids = Array.isArray(prevData) ? prevData : Object.keys(prevData);
        const prevMap = Array.isArray(prevData) ? {} : prevData;
        // 실제 예약이 하나라도 있을 때만 기억표 갱신 — not available 블록만 있으면 빈 맵이 되어
        // 기존 기록을 지워버리고 다음 싱크에서 이미 알림 보낸 예약을 신규로 오감지하는 버그 방지
        if (uids.length > 0) roomCurr[p.key] = bookingMap;
        const newOnes = uids.filter(u => !prevUids.includes(u));
        const cancelled = prevUids.filter(u => !uids.includes(u));
        const sixMonthsLater = new Date();
        sixMonthsLater.setMonth(sixMonthsLater.getMonth() + 6);
        for (const uid of newOnes) {
          const b = bookingMap[uid];
          if (new Date(b.cinY, b.cinM, b.cinD) > sixMonthsLater) continue;
          const msg = { title: `📅 ${room.name} 새 예약`, body: `${p.label} ${b.cin}~${b.cout}`, room: room.name };
          await sendPushToAll(env, msg);
          await saveEvent(env, { type: 'new', room: room.name, platform: p.label, cin: b.cin, cout: b.cout, ts: Date.now() });
        }
      }
    }
    return { name: room.name, bookings, roomCurr };
  }));
  // 고정된 호실 순서(rooms 배열 순서) + 고정된 플랫폼 순서(ab,bk,tr,lv)로 합쳐서
  // 매번 같은 키 순서가 나오도록 보장
  for (const r of roomResults) {
    synced_bookings[r.name] = r.bookings;
    if (withPush) {
      for (const key of ['ab', 'bk', 'tr', 'lv']) {
        if (r.roomCurr[key]) curr[r.name + '_' + key] = r.roomCurr[key];
      }
    }
  }
  // 트립 당일잠금 판정 — 갓 받은 피드로 판단해야 하므로 여기서 한 번만 돌린다.
  // 실패해도 sync 결과는 지켜야 하므로 삼킨다 (교정 안 함 = 지금까지와 동일 동작).
  let daylock = {};
  try { daylock = await updateDaylock(env, synced_bookings); } catch (e) {}

  // ⚠ 아카이브에는 교정본을 넣는다. 아래 '부분 스냅샷 제거'는 포함되는 짧은 쪽을 버리는데,
  //   가짜 잠금은 예약을 항상 길게 만들어 매번 가짜가 이긴다 (8/26~8/30 이 8/27~8/30 을 밀어냄).
  //   장부는 되돌릴 수 없으므로 들어오기 전에 거른다. synced_bookings 원본은 손대지 않는다.
  const freshArchive = applyDaylock(newArchive, daylock);

  // 아카이브 병합: synced_bookings와 완전 분리된 별도 저장
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 13);
  cutoff.setHours(0, 0, 0, 0);
  const mergedArchive = {};
  for (const room of rooms) {
    const prevRoom = prevArchive[room.name] || {};
    const freshRoom = freshArchive[room.name] || {};
    mergedArchive[room.name] = {};
    for (const key of ['ab', 'bk', 'tr', 'lv']) {
      const existing = prevRoom[key] || [];
      // 플랫폼별 블락 구분 규칙이 다름:
      // ab: "not available"만 블락 / bk: 실제 예약도 전부 "CLOSED - Not available"로 옴 → 전부 보존
      // tr·lv: "not available"은 파서에서 이미 제거됨, 실제 예약은 제목이 비어 올 수 있음 → "closed"만 제외
      const incoming = (freshRoom[key] || []).filter(b => {
        const s = (b.summary || '').toLowerCase();
        if (key === 'ab') return !s.includes('not available');
        if (key === 'bk') return true;
        return s !== 'closed';
      });
      const existingUids = new Set(existing.map(b => `${b.cinY}_${b.cinM}_${b.cinD}_${b.coutY}_${b.coutM}_${b.coutD}`));
      const merged = [...existing];
      for (const b of incoming) {
        const uid = `${b.cinY}_${b.cinM}_${b.cinD}_${b.coutY}_${b.coutM}_${b.coutD}`;
        if (!existingUids.has(uid)) merged.push(b);
      }
      // 부분 스냅샷 제거: 같은 플랫폼에서 다른 항목 범위 안에 완전히 포함되면 잔재로 판단
      // (Trip.com은 매일 "오늘~체크아웃" 형태로 시작일이 당겨진 피드를 보내 같은 숙박이 여러 장 쌓임.
      //  같은 플랫폼에서 실제로 겹치는 예약은 존재할 수 없으므로 포함 관계 = 같은 숙박의 옛 버전)
      const dn = (y, m, d) => new Date(y, m, d).getTime();
      mergedArchive[room.name][key] = merged.filter(b => {
        if (new Date(b.coutY, b.coutM, b.coutD) < cutoff) return false;
        const bs = dn(b.cinY, b.cinM, b.cinD), be = dn(b.coutY, b.coutM, b.coutD);
        return !merged.some(o => {
          if (o === b) return false;
          const os = dn(o.cinY, o.cinM, o.cinD), oe = dn(o.coutY, o.coutM, o.coutD);
          return os <= bs && oe >= be && (os < bs || oe > be);
        });
      });
    }
  }

  const newSyncedRaw = JSON.stringify(synced_bookings);
  if (newSyncedRaw !== prevSyncedRaw) await env.HANA_KV.put('synced_bookings', newSyncedRaw);
  const newArchiveRaw = JSON.stringify(mergedArchive);
  if (newArchiveRaw !== prevArchiveRaw) await env.HANA_KV.put('booking_archive', newArchiveRaw);
  if (withPush) {
    const mergedCurr = { ...prev, ...curr };
    const newUidsRaw = JSON.stringify(mergedCurr);
    if (newUidsRaw !== prevUidsRaw) await env.PUSH_KV.put('last_booking_uids', newUidsRaw);
  }

  // 복구 처리 일괄 적용: 루프 완료 후 최신 events KV를 다시 읽어 안전하게 수정
  if (withPush && recoveryActions.length > 0) {
    const evRaw = await env.PUSH_KV.get('events');
    const evts = evRaw ? JSON.parse(evRaw) : [];
    for (const { room, platform } of recoveryActions) {
      evts.forEach(e => {
        if (e.type === 'error' && !e.read && e.room === room && e.platform === platform) e.read = true;
      });
      const recId = Date.now() + '_' + Math.random().toString(36).slice(2, 7);
      evts.unshift({ id: recId, type: 'recovered', room, platform, cin: '', cout: '', ts: Date.now(), read: false });
      await sendPushToAll(env, { title: `✅ ${room} 다시 연결됨`, body: `${platform} iCal 연결이 복구됐어요`, room });
    }
    if (evts.length > 50) evts.splice(50);
    await env.PUSH_KV.put('events', JSON.stringify(evts));
  }

  return { synced: rooms.length, time: new Date().toISOString() };
}

async function saveEvent(env, event) {
  const raw = await env.PUSH_KV.get('events');
  const events = raw ? JSON.parse(raw) : [];
  event.id = Date.now() + '_' + Math.random().toString(36).slice(2,7);
  event.read = false;
  events.unshift(event);
  // 최대 50개 유지
  if (events.length > 50) events.splice(50);
  await env.PUSH_KV.put('events', JSON.stringify(events));
}

async function sendPushToAll(env, data) {
  const keys = await env.PUSH_KV.list({ prefix: 'sub_' });
  let sent = 0;
  for (const k of keys.keys) {
    const subJson = await env.PUSH_KV.get(k.name);
    if (!subJson) continue;
    try {
      const status = await sendWebPush(env, JSON.parse(subJson), data);
      if (status === 410 || status === 404) await env.PUSH_KV.delete(k.name);
      else sent++;
    } catch(e) {}
  }
  return sent;
}

async function fetchAndParseIcal(url, platform) {
  try {
    const resp = await fetch(url.replace(/^webcal:\/\//i, 'https://'), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    return parseIcal(await resp.text(), platform);
  } catch { return null; }
}

function parseIcal(text, platform) {
  const bookings = [];
  const events = text.split('BEGIN:VEVENT');
  for (let i = 1; i < events.length; i++) {
    const block = events[i];
    const dtstart = (block.match(/DTSTART(?:;[^:]*)?:(\d{8})/) || [])[1];
    const dtend   = (block.match(/DTEND(?:;[^:]*)?:(\d{8})/)   || [])[1];
    const summary = (block.match(/SUMMARY:(.+)/)                || [])[1]?.trim() || '';
    if (!dtstart || !dtend) continue;
    const pd = d => ({ y: +d.slice(0,4), m: +d.slice(4,6)-1, d: +d.slice(6,8) });
    let cin = pd(dtstart), cout = pd(dtend);
    // 에어비앤비 "Not Available"은 DTEND가 체크아웃 다음날로 옴 → 하루 빼서 실제 체크아웃일로 저장
    if (platform === 'airbnb' && summary.toLowerCase().includes('not available')) {
      const coutDate = new Date(cout.y, cout.m, cout.d);
      coutDate.setDate(coutDate.getDate() - 1);
      cout = { y: coutDate.getFullYear(), m: coutDate.getMonth(), d: coutDate.getDate() };
    }
    if (platform !== 'booking' && platform !== 'airbnb' && summary.toLowerCase().includes('not available')) continue;
    if (platform === 'airbnb' && summary === 'Reserved') {
      const desc = (block.match(/DESCRIPTION:(.+)/) || [])[1] || '';
      if (!desc.includes('airbnb.com/hosting/reservations')) continue;
    }
    const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1); oneYearAgo.setHours(0,0,0,0);
    const coutDate = new Date(cout.y, cout.m, cout.d);
    if (coutDate < oneYearAgo) continue;
    bookings.push({ cinY: cin.y, cinM: cin.m, cinD: cin.d, coutY: cout.y, coutM: cout.m, coutD: cout.d, platform, summary });
  }
  return bookings;
}

// 부킹닷컴·트립닷컴은 실제 예약과 '판매 미오픈 기간'의 제목이 완전히 같다
// (bk: 둘 다 "CLOSED - Not available" / tr: 둘 다 "RoomStatus Fully booked").
// 두 채널은 오늘부터 6개월까지만 판매를 열어두므로, 그 범위 밖에서 끝나는 항목은
// 실제 예약일 수 없다 = 전부 미오픈 기간. 체크인이 아니라 체크아웃으로 재야 한다.
// (402호 트립 2027-01-01~06-15처럼 경계 안쪽에서 시작해 한참 뒤까지 뻗는 꼬리가 있음)
// ⚠ 채널 쪽 판매 오픈 기간을 6개월로 정리한 뒤 켤 것. 기준선이 실제보다 짧으면 진짜 예약이 안 나가 오버부킹.
const HORIZON_ENABLED  = false;
const OPEN_MONTHS_BK_TR = 6;
const GRACE_DAYS        = 7;   // 채널이 월말 단위로 끊는 등 미세하게 더 열어줄 여지

// 채널 전용 내보내기 주소 (/ical/<호실>/<키>). 그 채널 자기 예약만 빼고 내보낸다.
const EXPORT_TARGETS = ['ab', 'bk', 'tr', 'lv'];

const dayMs = (y, m, d) => Date.UTC(y, m, d);

// 워커는 UTC로 도는데 숙소는 한국 → 9시간 보정해서 '한국 기준 오늘'을 구한다
function todayKST() {
  const n = new Date(Date.now() + 9 * 3600 * 1000);
  return { y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate() };
}

// ══════════════════════════════════════════════════════════════════════════
// 트립 당일잠금 걷어내기 (trip-daylock)
// ══════════════════════════════════════════════════════════════════════════
// 왜: 트립 자동 규칙 '전략 제어 – 당일 객실 마감'이 매일 KST 17:59:59에 그날을 만실로 바꾸고
//     다음날 07:00에 되돌린다 (05-known-issues #28). 트립 iCal은 손님 밤과 잠긴 밤을 똑같이
//     'RoomStatus Fully booked'로 내보내고, 날짜가 맞닿으면 한 덩어리 VEVENT로 합쳐 보낸다.
//     → 입실이 하루 당겨지거나(402호 9/1) 퇴실이 하루 밀려(#28) 보인다.
//     파일 내용으로는 진짜 예약과 구분할 수 없다. 그래서 '시각'으로 가른다.
// 자물쇠 2개, 둘 다 맞을 때만 걷어낸다:
//   ① 안전창(07:30~17:30) 마지막 관측에 그 밤이 비어 있었다  → 손님이면 낮에도 막혀 있었을 것
//   ② 18:00~18:10 차례에 처음 나타났다                       → 자동 규칙의 지문 (실측 18:00:57~18:01:01)
// 하나라도 어긋나면 원본 그대로 둔다. 헷갈리면 무조건 막는 쪽 = 오버부킹이 나는 방향으로 안 틀린다.
// 상세: docs/features/trip-daylock.md
const SAFE_FROM_MIN = 7 * 60 + 30;    // KST 07:30 — 안전창 시작
const SAFE_TO_MIN   = 17 * 60 + 30;   // KST 17:30 — 안전창 끝 (17:59:59 잠금 전)
const LOCK_FROM_MIN = 18 * 60;        // KST 18:00 — 자물쇠 ②
const LOCK_TO_MIN   = 18 * 60 + 10;   // KST 18:10 — 크론 지연 여유

const ymdStr = (y, m, d) => `${y}${String(m + 1).padStart(2, '0')}${String(d).padStart(2, '0')}`;
const ymdMs  = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));

// todayKST + 자정부터 지난 분
function kstNow() {
  const n = new Date(Date.now() + 9 * 3600 * 1000);
  return {
    y: n.getUTCFullYear(), m: n.getUTCMonth(), d: n.getUTCDate(),
    min: n.getUTCHours() * 60 + n.getUTCMinutes(),
  };
}

// 밤 [ms, ms+1일) 이 조각에 덮이는가. cout는 exclusive이므로 cin <= ms < cout.
const coversNight = (segs, ms) => (segs || []).some(b =>
  dayMs(b.cinY, b.cinM, b.cinD) <= ms && ms < dayMs(b.coutY, b.coutM, b.coutD));

// 그 밤 하나만 빼고 앞뒤 조각을 남긴다. 빈 조각은 버린다.
//   [9/1,9/11) − 9/1밤  = [9/2,9/11)                입실 쪽
//   [8/10,8/13) − 8/12밤 = [8/10,8/12)               퇴실 쪽
//   [8/10,8/15) − 8/12밤 = [8/10,8/12)+[8/13,8/15)   양쪽 (경계 복원)
//   [9/1,9/2)  − 9/1밤  = (사라짐)                   홀로
function subtractNight(segs, ms) {
  const next = ms + 86400000;
  const mk = (a, z, b) => {
    const A = new Date(a), Z = new Date(z);
    return {
      cinY: A.getUTCFullYear(), cinM: A.getUTCMonth(), cinD: A.getUTCDate(),
      coutY: Z.getUTCFullYear(), coutM: Z.getUTCMonth(), coutD: Z.getUTCDate(),
      platform: b.platform, summary: b.summary,
    };
  };
  const out = [];
  for (const b of segs || []) {
    const s = dayMs(b.cinY, b.cinM, b.cinD), e = dayMs(b.coutY, b.coutM, b.coutD);
    if (!(s <= ms && next <= e)) { out.push(b); continue; }   // 그 밤을 안 덮음 → 그대로
    if (s < ms)   out.push(mk(s, ms, b));
    if (next < e) out.push(mk(next, e, b));
  }
  return out;
}

// 매 sync 뒤 호출. 상태를 갱신하고 판정 결과를 돌려준다.
// ⚠ fake 는 '오늘'이 아니라 '잠긴 밤'을 기억한다. 잠금은 18:00에 생겨 다음날 07:00까지 살아 있어서,
//   '오늘' 기준으로 만들면 자정에 초기화돼 새벽 0~7시가 다시 틀린다 (사용자가 본 시각이 01:11이었다).
async function updateDaylock(env, synced) {
  const t = kstNow();
  const today = ymdStr(t.y, t.m, t.d);
  const raw = await env.HANA_KV.get('tr_daylock');
  let st; try { st = JSON.parse(raw || '{}'); } catch (e) { st = {}; }
  if (!st || typeof st !== 'object') st = {};
  st.seen = st.seen || {};
  st.fake = st.fake || {};
  if (st.day !== today) { st.day = today; st.seen = {}; }   // fake 는 이월한다 (자정 넘김)

  const inSafe = t.min >= SAFE_FROM_MIN && t.min <= SAFE_TO_MIN;
  const inLock = t.min >= LOCK_FROM_MIN && t.min <= LOCK_TO_MIN;
  const todayMs = dayMs(t.y, t.m, t.d);
  const oldest  = dayMs(t.y, t.m, t.d - 1);   // 잠긴 밤이 어제보다 오래되면 버린다

  for (const [room, data] of Object.entries(synced || {})) {
    const tr = (data && data.tr) || [];
    if (inSafe) {
      st.seen[room] = coversNight(tr, todayMs);   // 낮 관측 갱신
      delete st.fake[room];                       // 낮에는 잠금이 없다
      continue;
    }
    // 이미 판정된 건: 피드가 그 밤을 더 이상 안 덮으면 스스로 정리 (07:00 해제 시 자동)
    const f = st.fake[room];
    if (f) {
      const nightMs = ymdMs(f.night);
      if (nightMs < oldest || !coversNight(tr, nightMs)) delete st.fake[room];
      continue;
    }
    // 자물쇠 ① 안전창에 비어 있었다  +  ② 18:00~18:10 차례에 처음 나타났다
    if (st.seen[room] === false && inLock && coversNight(tr, todayMs)) {
      st.fake[room] = { night: today, min: t.min };
    }
  }

  const next = JSON.stringify(st);
  if (next !== (raw || '')) await env.HANA_KV.put('tr_daylock', next);   // 내용 바뀔 때만 write
  return st;
}

// 판정 결과를 호실별 예약 묶음에 적용한다. tr 만 건드린다.
function applyDaylock(rooms, st) {
  if (!st || !st.fake || !Object.keys(st.fake).length) return rooms;
  const out = {};
  for (const [room, data] of Object.entries(rooms || {})) {
    const f = st.fake[room];
    out[room] = (f && data && data.tr)
      ? { ...data, tr: subtractNight(data.tr, ymdMs(f.night)) }
      : data;
  }
  return out;
}

// 읽기 경로(/bookings, /?url=&fix=tr)용 — KV에서 판정을 읽기만 한다. 쓰지 않는다.
async function readDaylock(env) {
  try { return JSON.parse(await env.HANA_KV.get('tr_daylock') || '{}'); } catch (e) { return {}; }
}

// 소급 청소 (1회성) — 8/25 재점화 이후 장부에 굳어버린 가짜를 교정한다.
// 알림 로그(PUSH_KV 'events')에 KST 18:00~18:10 도장이 찍힌 트립 이벤트가 곧 가짜다.
// ⚠ 삭제가 아니라 '그 밤만 빼기'다. 그냥 지우면 붙어 있던 진짜 숙박까지 사라진다.
//    실측 검증: 8/26~8/30 에서 8/26밤을 빼면 8/27~8/30 — 트립이 다음날 07:00:55 에 보낸 값과 같다.
// 멱등 — 이미 교정된 건은 장부에서 원본을 못 찾으므로 건너뛴다. 여러 번 눌러도 안전하다.
async function backfillDaylock(env, dryRun) {
  const evts = JSON.parse(await env.PUSH_KV.get('events') || '[]');
  const archRaw = await env.HANA_KV.get('booking_archive') || '{}';
  const archive = JSON.parse(archRaw);
  const applied = [], skipped = [];
  const same = (a, b) => a.cinY === b.cinY && a.cinM === b.cinM && a.cinD === b.cinD
                      && a.coutY === b.coutY && a.coutM === b.coutM && a.coutD === b.coutD;

  for (const ev of evts) {
    if (ev.platform !== 'Trip.com' || !ev.cin || !ev.cout || !ev.ts) continue;
    const k = new Date(ev.ts + 9 * 3600 * 1000);
    const min = k.getUTCHours() * 60 + k.getUTCMinutes();
    if (min < LOCK_FROM_MIN || min > LOCK_TO_MIN) continue;      // 18:00~18:10 도장만
    const nightMs = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate());
    const pd = s => s.split('/').map(Number);
    const [ay, am, ad] = pd(ev.cin), [zy, zm, zd] = pd(ev.cout);
    const target = { cinY: ay, cinM: am - 1, cinD: ad, coutY: zy, coutM: zm - 1, coutD: zd };
    const label = `${ev.room} ${ev.cin}~${ev.cout} (${ev.cin} 밤 잠금)`;

    const list = archive[ev.room] && archive[ev.room].tr;
    const idx = list ? list.findIndex(b => same(b, target)) : -1;
    if (idx < 0) { skipped.push(`${label} — 장부에 없음(이미 교정됨)`); continue; }

    const fixed = subtractNight([list[idx]], nightMs)
      .filter(f => !list.some((b, i) => i !== idx && same(b, f)));   // 중복 방지
    list.splice(idx, 1, ...fixed);
    applied.push(`${label} → ${fixed.length ? fixed.map(f =>
      `${ymdStr(f.cinY, f.cinM, f.cinD)}~${ymdStr(f.coutY, f.coutM, f.coutD)}`).join(' + ') : '(삭제)'}`);
  }
  if (!dryRun && applied.length) await env.HANA_KV.put('booking_archive', JSON.stringify(archive));
  return { dryRun: !!dryRun, count: applied.length, applied, skipped };
}

// 청소앱용 — iCal 원문에서 가짜 하룻밤만 도려낸다.
// ⚠ 다시 만들지 않고 해당 VEVENT 블록의 날짜만 바꾼다. 나머지 줄(UID·DTSTAMP·SUMMARY·헤더·꼬리)은
//   원문 그대로 지나간다. 청소앱 파서가 SUMMARY로 블락을 거르므로 제목이 바뀌면 안 된다.
// 걸리는 게 없으면 원문을 그대로 돌려준다.
async function fixTripIcalText(env, text, roomName) {
  if (!roomName) return text;
  const st = await readDaylock(env);
  const f = st && st.fake && st.fake[roomName];
  if (!f) return text;

  const nightMs = ymdMs(f.night), nextMs = nightMs + 86400000;
  const fmt = ms => { const d = new Date(ms); return ymdStr(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
  const setDates = (blk, a, z) => blk
    .replace(/(DTSTART(?:;[^:]*)?:)\d{8}/, `$1${a}`)
    .replace(/(DTEND(?:;[^:]*)?:)\d{8}/,   `$1${z}`);

  const parts = text.split('BEGIN:VEVENT');
  let out = parts[0], changed = false;
  for (let i = 1; i < parts.length; i++) {
    // VEVENT 본문과 그 뒤 꼬리(END:VCALENDAR 등)를 나눠 둔다 — 마지막 블록을 지울 때 꼬리를 잃지 않게
    const m = parts[i].match(/^([\s\S]*?END:VEVENT\r?\n?)([\s\S]*)$/);
    const body = m ? m[1] : parts[i], tail = m ? m[2] : '';
    const ds = (body.match(/DTSTART(?:;[^:]*)?:(\d{8})/) || [])[1];
    const de = (body.match(/DTEND(?:;[^:]*)?:(\d{8})/)   || [])[1];
    const s = ds ? ymdMs(ds) : null, e = de ? ymdMs(de) : null;

    if (s === null || e === null || !(s <= nightMs && nextMs <= e)) {
      out += 'BEGIN:VEVENT' + body + tail;                  // 그 밤을 안 덮음 → 원문 그대로
      continue;
    }
    changed = true;
    if (s < nightMs) out += 'BEGIN:VEVENT' + setDates(body, fmt(s), fmt(nightMs));
    if (nextMs < e)  out += 'BEGIN:VEVENT' + setDates(body, fmt(nextMs), fmt(e));
    out += tail;                                            // 둘 다 없으면 블록 자체가 사라진다
  }
  return changed ? out : text;
}

// target = null                → 레거시 통합 주소 (/ical/<호실>). 동작을 절대 바꾸지 않는다
// target = 'ab'|'bk'|'tr'|'lv'  → 그 채널 전용 주소. 자기 예약을 돌려주지 않는다
async function exportIcal(env, roomName, target = null) {
  const lbl = { ab: 'Airbnb', bk: 'Booking.com', tr: 'Trip.com', lv: '리브애니웨어' };
  let events = '', uid = 1;
  const t = todayKST();
  const today   = dayMs(t.y, t.m, t.d);
  const horizon = dayMs(t.y, t.m + OPEN_MONTHS_BK_TR, t.d + GRACE_DAYS);  // Date.UTC가 월/일 넘침을 보정
  const data = await env.HANA_KV.get('synced_bookings');
  const roomBookings = data ? JSON.parse(data)[roomName] : null;
  if (roomBookings) {
    for (const [key, bks] of Object.entries(roomBookings)) {
      // ⓪ 채널 전용 주소: 그 채널 자기 예약은 돌려주지 않는다.
      //    돌려주면 채널이 "남의 달력에서 온 블락"으로 인식해 자기 iCal에서 빼버린다.
      //    2026-08-06 부킹닷컴 603호 9/8~9/12 실제 발생 (05-known-issues #26).
      if (target && key === target) continue;

      for (const bk of bks) {
        // ① 에어비앤비 "Not Available" 처리
        //    레거시 주소는 모두가 공유하므로 내보내면 에어비앤비가 되읽어 순환 → 제외 (현행 유지).
        //    채널 전용 주소는 ⓪에서 에어비앤비가 이미 걸러지므로 순환 위험이 없다 →
        //    블락을 내보내야 트립·부킹이 그 날짜를 막는다. (막았는데 안 나가던 구멍 해소)
        if (!target && key === 'ab' && bk.summary?.toLowerCase().includes('not available')) continue;

        // ② 부킹·트립: 판매 오픈 범위 밖에서 끝나면 실제 예약일 수 없다 → 제외
        if (HORIZON_ENABLED && (key === 'bk' || key === 'tr')
            && dayMs(bk.coutY, bk.coutM, bk.coutD) > horizon) continue;

        // ③ 이미 지난 예약은 오버부킹이 날 수 없다 → 내보내지 않음 (오늘 체크아웃은 유지)
        if (dayMs(bk.coutY, bk.coutM, bk.coutD) < today) continue;

        const ds = `${bk.cinY}${String(bk.cinM+1).padStart(2,'0')}${String(bk.cinD).padStart(2,'0')}`;

        // 에어비앤비 블락은 예약이 아니다. 채널 전용 주소에서만 나간다 (①에서 레거시는 걸러짐)
        const isBlk = key === 'ab' && bk.summary?.toLowerCase().includes('not available');

        // DTEND는 체크아웃일 그대로 — iCal에서 DTEND는 '포함 안 되는 날'이라 체크아웃 당일은
        // 이미 예약 가능일로 나간다. 여기서 하루를 더 빼면 마지막 숙박일까지 열려 오버부킹.
        //
        // ⚠ 단, 에어비앤비 블락만 예외다. parseIcal이 저장할 때 DTEND에서 하루를 빼
        //   cout = '막힌 마지막 날'(포함)로 바꿔놨다. 그대로 내보내면 길이 0이 되어 아무것도 안 막는다.
        //   → 하루를 도로 더해 exclusive 로 되돌린다. 수동 블락(아래)과 같은 처리.
        let deY = bk.coutY, deM = bk.coutM, deD = bk.coutD;
        if (isBlk) {
          const e = new Date(bk.coutY, bk.coutM, bk.coutD);
          e.setDate(e.getDate() + 1);
          deY = e.getFullYear(); deM = e.getMonth(); deD = e.getDate();
        }
        const de = `${deY}${String(deM+1).padStart(2,'0')}${String(deD).padStart(2,'0')}`;

        events += `BEGIN:VEVENT\r\nUID:hana-${roomName}-${key}-${uid++}@vagabond1984.workers.dev\r\nDTSTART;VALUE=DATE:${ds}\r\nDTEND;VALUE=DATE:${de}\r\nSUMMARY:${lbl[key]||key} ${isBlk ? '블락' : '예약'} (${roomName})\r\nEND:VEVENT\r\n`;
      }
    }
  }
  const blocksRaw = await env.HANA_KV.get('extra_manual_blocks');
  if (blocksRaw) {
    const blocks = JSON.parse(blocksRaw);
    const roomBlocks = Array.isArray(blocks) ? blocks.filter(b => b.roomName === roomName) : [];
    for (const bl of roomBlocks) {
      if (dayMs(bl.endY, bl.endM, bl.endD) < today) continue;   // 지난 수동 블락은 내보낼 이유가 없다
      const ds = `${bl.startY}${String(bl.startM+1).padStart(2,'0')}${String(bl.startD).padStart(2,'0')}`;
      const endDate = new Date(bl.endY, bl.endM, bl.endD);
      endDate.setDate(endDate.getDate() + 1);
      const de = `${endDate.getFullYear()}${String(endDate.getMonth()+1).padStart(2,'0')}${String(endDate.getDate()).padStart(2,'0')}`;
      events += `BEGIN:VEVENT\r\nUID:hana-${roomName}-block-${uid++}@vagabond1984.workers.dev\r\nDTSTART;VALUE=DATE:${ds}\r\nDTEND;VALUE=DATE:${de}\r\nSUMMARY:Blocked\r\nEND:VEVENT\r\n`;
    }
  }
  return new Response(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//HANA STAY//KO\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:${roomName} 예약현황\r\n${events}END:VCALENDAR\r\n`, { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
}

function emptyIcal(n) {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//HANA STAY//KO\r\nCALSCALE:GREGORIAN\r\nX-WR-CALNAME:${n} 예약현황\r\nEND:VCALENDAR\r\n`;
}
function json(data, request, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors(request) } });
}
function cors(request) {
  const origin = (request && request.headers.get('Origin')) || '';
  const allowed = ALLOWED.some(d => origin === 'https://' + d || origin === 'http://' + d);
  return { 'Access-Control-Allow-Origin': allowed ? origin : '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}
