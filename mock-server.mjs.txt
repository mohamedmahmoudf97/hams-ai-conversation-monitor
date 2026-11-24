// Hams.AI frontend assessment: mock API and live event stream.
// Node 18+, no dependencies. Run: node mock-server.mjs  (serves http://localhost:4000)
import http from 'node:http';

const PORT = Number(process.env.PORT) || 4000;
const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const now = () => new Date().toISOString();

const NAMES = ['Sara Alqahtani', 'محمد العتيبي', 'John Carter', 'نورة الشهري', 'Omar Haddad', 'ليلى الحربي', 'Daniel Kim', 'فهد الدوسري'];
const CUSTOMER_LINES = [
  'Hi, my order #48213 still shows "processing". Any update?',
  'السلام عليكم، طلبي ما وصل إلى الآن',
  'I was charged twice for my last bill.',
  'أبغى أغير موعد التوصيل لو سمحت',
  'The internet keeps disconnecting since yesterday.',
  'هل يمكنني إلغاء الاشتراك Premium بدون رسوم؟',
  'Can I speak to someone about a refund?',
  'شكراً، بس الرقم المرجعي ما وصلني على الجوال',
];
const AI_LINES = [
  'Thanks for waiting. Your order #48213 left our warehouse this morning and should arrive tomorrow.',
  'شكراً لتواصلك معنا. تم تحديث موعد التوصيل إلى يوم الخميس بين ٤ و٦ مساءً.',
  'I reset your router remotely. Please wait two minutes, then try connecting again.',
  'حسب سجلاتنا، تم استرداد المبلغ إلى بطاقتك وسيظهر خلال ٣ أيام عمل.',
  'Your appointment is confirmed for Sunday at 10:30 AM. You will get an SMS reminder.',
  'تم تفعيل باقة الإنترنت Unlimited Plus على رقمك بنجاح، وتبدأ من اليوم.',
  'I can see the duplicate charge of 149 SAR. I have opened a ticket to reverse it.',
  'رقمك المرجعي هو HX-2291، وأرسلته لك الآن برسالة نصية.',
];
const REASONS = [
  'Refund is above the AI limit (500 SAR)',
  'Customer asked to speak to a person',
  'Billing dispute needs a supervisor',
  'العميل غير راضٍ ويطلب موظفاً',
];

// ---- State -------------------------------------------------------------------------------
let messageSeq = 0;
const conversations = new Map(); // id -> { id, customer, status, lastMessage, unread, updatedAt }
const messages = new Map(); // conversationId -> Message[]
const streaming = new Set(); // conversation ids with an AI reply in progress

function addMessage(conversationId, role, text, extra = {}) {
  const message = { id: `m-${++messageSeq}`, conversationId, role, text, createdAt: now(), ...extra };
  messages.get(conversationId).push(message);
  return message;
}

NAMES.forEach((customer, i) => {
  const id = `c-${i + 1}`;
  const status = i === 6 ? 'needs_human' : i === 7 ? 'closed' : 'ai';
  conversations.set(id, { id, customer, status, lastMessage: '', unread: rand(0, 3), updatedAt: now() });
  messages.set(id, []);
  const count = i === 0 ? 5000 : rand(6, 30); // c-1 is the large conversation
  for (let k = 0; k < count; k++) {
    addMessage(id, k % 2 ? 'ai' : 'customer', k % 2 ? pick(AI_LINES) : pick(CUSTOMER_LINES));
  }
  conversations.get(id).lastMessage = messages.get(id).at(-1).text;
});

// ---- Event log and stream ----------------------------------------------------------------
const events = []; // every event ever emitted, kept for replay
let lastEventId = 0;
const clients = new Set();
const frame = (event) => `id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;

function emit(payload) {
  const event = { id: ++lastEventId, ...payload };
  events.push(event);
  for (const res of clients) res.write(frame(event));
  return event;
}

function setStatus(conversation, status) {
  conversation.status = status;
  conversation.updatedAt = now();
  if (status === 'needs_human') conversation.needsHumanSince = Date.now();
  emit({ type: 'status', conversationId: conversation.id, status });
}

// ---- Simulation --------------------------------------------------------------------------
function streamAiReply(conversationId) {
  const conversation = conversations.get(conversationId);
  if (!conversation || conversation.status !== 'ai' || streaming.has(conversationId)) return;
  streaming.add(conversationId);
  const message = addMessage(conversationId, 'ai', '', { streaming: true });
  emit({ type: 'message_start', conversationId, messageId: message.id, role: 'ai' });
  const words = pick(AI_LINES).split(' ');
  let i = 0;
  const next = () => {
    if (i < words.length) {
      const text = (i === 0 ? '' : ' ') + words[i++];
      message.text += text;
      emit({ type: 'token', conversationId, messageId: message.id, text });
      setTimeout(next, rand(60, 160));
      return;
    }
    delete message.streaming;
    conversation.lastMessage = message.text;
    conversation.updatedAt = now();
    emit({ type: 'message_end', conversationId, messageId: message.id });
    streaming.delete(conversationId);
  };
  setTimeout(next, rand(200, 500));
}

// A customer writes every 2.5 s; the AI answers in conversations it is handling.
setInterval(() => {
  const open = [...conversations.values()].filter((c) => c.status !== 'closed' && !streaming.has(c.id));
  if (!open.length) return;
  const conversation = pick(open);
  const message = addMessage(conversation.id, 'customer', pick(CUSTOMER_LINES));
  conversation.lastMessage = message.text;
  conversation.unread += 1;
  conversation.updatedAt = now();
  emit({ type: 'message', conversationId: conversation.id, message });
  if (conversation.status === 'ai' && streaming.size < 2) {
    setTimeout(() => streamAiReply(conversation.id), rand(500, 1200));
  }
}, 2500);

// Every 25 to 35 s the AI hands one conversation over to a human.
(function scheduleHandoff() {
  setTimeout(() => {
    const ready = [...conversations.values()].filter((c) => c.status === 'ai' && !streaming.has(c.id));
    if (ready.length) {
      const conversation = pick(ready);
      emit({ type: 'tool_call', conversationId: conversation.id, name: 'transfer_to_human', args: { reason: pick(REASONS) } });
      setStatus(conversation, 'needs_human');
    }
    scheduleHandoff();
  }, rand(25000, 35000));
})();

// Keep the demo alive: unanswered hand-offs go back to the AI after 3 minutes,
// and a closed conversation reopens when fewer than 3 are left with the AI.
setInterval(() => {
  const all = [...conversations.values()];
  for (const c of all) {
    if (c.status === 'needs_human' && Date.now() - (c.needsHumanSince || 0) > 180000) setStatus(c, 'ai');
  }
  if (all.filter((c) => c.status === 'ai').length < 3) {
    const closed = all.find((c) => c.status === 'closed');
    if (closed) setStatus(closed, 'ai');
  }
}, 30000);

// Every 20 to 40 s the server drops every live connection.
(function scheduleDrop() {
  setTimeout(() => {
    for (const res of clients) res.destroy();
    clients.clear();
    scheduleDrop();
  }, rand(20000, 40000));
})();

// ---- HTTP --------------------------------------------------------------------------------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Last-Event-ID',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve(null);
      }
    });
  });
}

function openStream(req, res, url) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS });
  res.write('retry: 3000\n\n');
  const since = url.searchParams.get('since') ?? req.headers['last-event-id'];
  if (since !== undefined && since !== null && since !== '') {
    // On purpose, the replay starts 3 events early: your client must ignore events it already has.
    const from = Math.max(0, Number(since) - 3);
    for (const event of events) if (event.id > from) res.write(frame(event));
  }
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean); // e.g. ['conversations', 'c-1', 'messages']
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/events') return openStream(req, res, url);
  if (req.method === 'GET' && url.pathname === '/conversations') {
    const list = [...conversations.values()]
      .map(({ needsHumanSince, ...c }) => c)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return send(res, 200, { lastEventId, conversations: list });
  }
  if (parts[0] !== 'conversations' || !parts[1]) return send(res, 404, { error: 'Not found' });
  const conversation = conversations.get(parts[1]);
  if (!conversation) return send(res, 404, { error: 'Conversation not found' });

  if (req.method === 'GET' && parts[2] === 'messages') {
    return send(res, 200, { lastEventId, messages: messages.get(conversation.id) });
  }
  if (req.method === 'POST' && parts[2] === 'takeover') {
    if (conversation.status === 'closed') return send(res, 409, { error: 'Conversation is closed' });
    if (conversation.status !== 'human') setStatus(conversation, 'human');
    const { needsHumanSince, ...body } = conversation;
    return send(res, 200, { conversation: body });
  }
  if (req.method === 'POST' && parts[2] === 'messages') {
    const body = await readJson(req);
    if (!body || typeof body.text !== 'string' || !body.text.trim()) return send(res, 400, { error: 'text is required' });
    await new Promise((resolve) => setTimeout(resolve, rand(300, 900)));
    if (conversation.status !== 'human') return send(res, 409, { error: 'Take over the conversation first' });
    if (Math.random() < 0.2) return send(res, 500, { error: 'Random failure, please retry' });
    const extra = body.clientMessageId ? { clientMessageId: String(body.clientMessageId) } : {};
    const message = addMessage(conversation.id, 'human', body.text.trim(), extra);
    conversation.lastMessage = message.text;
    conversation.updatedAt = now();
    emit({ type: 'message', conversationId: conversation.id, message });
    return send(res, 201, { message });
  }
  return send(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => console.log(`Mock server on http://localhost:${PORT}`));
