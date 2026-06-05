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
    if (path.startsWith('/ical/')) {
      return await exportIcal(env, decodeURIComponent(path.replace('/ical/', '')));
    }
    const icalUrl = url.searchParams.get('url');
    if (!icalUrl) return json({ error: 'url 파라미터 없음' }, request, 400);
    const fetchUrl = icalUrl.replace(/^webcal:\/\//i, 'https://');
    try {
      const hostname = new URL(fetchUrl).hostname;
      if (!ALLOWED.some(d => hostname === d || hostname.endsWith('.' + d))) return json({ error: '허용되지 않은 도메인' }, request, 403);
      const resp = await fetch(fetchUrl);
      return new Response(await resp.text(), { headers: { 'Content-Type': 'text/calendar', ...cors(request) } });
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
  const prevSynced = JSON.parse(await env.HANA_KV.get('synced_bookings') || '{}');
  const prev = withPush ? JSON.parse(await env.PUSH_KV.get('last_booking_uids') || '{}') : {};
  const curr = {};
  await Promise.all(rooms.map(async (room) => {
    const prevRoomData = prevSynced[room.name] || {};
    const bookings = {
      ab: prevRoomData.ab || [],
      bk: prevRoomData.bk || [],
      tr: prevRoomData.tr || [],
      lv: prevRoomData.lv || [],
    };
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
        await env.PUSH_KV.delete(failKey);
      }
      bookings[p.key] = result;
      if (withPush) {
        const bookingMap = {};
        result.filter(b => !b.summary?.toLowerCase().includes('not available')).forEach(b => {
          const uid = b.summary + b.cinY + b.cinM + b.cinD;
          const cin  = `${b.cinY}/${String(b.cinM+1).padStart(2,'0')}/${String(b.cinD).padStart(2,'0')}`;
          const cout = `${b.coutY}/${String(b.coutM+1).padStart(2,'0')}/${String(b.coutD).padStart(2,'0')}`;
          bookingMap[uid] = { ...b, cin, cout };
        });
        const uids = Object.keys(bookingMap);
        const prevData = prev[room.name + '_' + p.key] || {};
        const prevUids = Array.isArray(prevData) ? prevData : Object.keys(prevData);
        const prevMap = Array.isArray(prevData) ? {} : prevData;
        curr[room.name + '_' + p.key] = bookingMap;
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
        for (const uid of cancelled) {
          const b = prevMap[uid] || {};
          if (b.cinY !== undefined && new Date(b.cinY, b.cinM, b.cinD) > sixMonthsLater) continue;
          const dateStr = b.cin ? `${b.cin}~${b.cout}` : '';
          const msg = { title: `❌ ${room.name} 예약 취소`, body: `${p.label}${dateStr ? ' ' + dateStr : ''} 취소됐어요.`, room: room.name };
          await sendPushToAll(env, msg);
          await saveEvent(env, { type: 'cancel', room: room.name, platform: p.label, cin: b.cin || '', cout: b.cout || '', ts: Date.now() });
        }
      }
    }
    synced_bookings[room.name] = bookings;
  }));
  await env.HANA_KV.put('synced_bookings', JSON.stringify(synced_bookings));
  await env.HANA_KV.put('last_sync', new Date().toISOString());
  if (withPush) await env.PUSH_KV.put('last_booking_uids', JSON.stringify(curr));
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
    const today = new Date(); today.setHours(0,0,0,0);
    const coutDate = new Date(cout.y, cout.m, cout.d);
    if (coutDate < today) continue;
    bookings.push({ cinY: cin.y, cinM: cin.m, cinD: cin.d, coutY: cout.y, coutM: cout.m, coutD: cout.d, platform, summary });
  }
  return bookings;
}

async function exportIcal(env, roomName) {
  const data = await env.HANA_KV.get('synced_bookings');
  if (!data) return new Response(emptyIcal(roomName), { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
  const roomBookings = JSON.parse(data)[roomName];
  if (!roomBookings) return new Response(emptyIcal(roomName), { headers: { 'Content-Type': 'text/calendar; charset=utf-8' } });
  const lbl = { ab: 'Airbnb', bk: 'Booking.com', tr: 'Trip.com', lv: '리브애니웨어' };
  let events = '', uid = 1;
  for (const [key, bks] of Object.entries(roomBookings)) {
    for (const bk of bks) {
      const ds = `${bk.cinY}${String(bk.cinM+1).padStart(2,'0')}${String(bk.cinD).padStart(2,'0')}`;
      const de = `${bk.coutY}${String(bk.coutM+1).padStart(2,'0')}${String(bk.coutD).padStart(2,'0')}`;
      events += `BEGIN:VEVENT\r\nUID:hana-${roomName}-${key}-${uid++}@vagabond1984.workers.dev\r\nDTSTART;VALUE=DATE:${ds}\r\nDTEND;VALUE=DATE:${de}\r\nSUMMARY:${lbl[key]||key} 예약 (${roomName})\r\nEND:VEVENT\r\n`;
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
