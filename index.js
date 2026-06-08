'use strict';

const express = require('express');
const cron    = require('node-cron');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

// node-fetch v3 is ESM-only; use dynamic import
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

const app = express();
app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────
const ZD_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;         // e.g. "incfile"
const ZD_EMAIL     = process.env.ZENDESK_EMAIL;
const ZD_TOKEN     = process.env.ZENDESK_API_TOKEN;
const SLACK_TOKEN  = process.env.SLACK_BOT_TOKEN;
const MANNY_ID     = process.env.MANNY_SLACK_ID || 'U09AV9NJQQY';
const SHEET_ID     = process.env.TICKET_MASTER_SHEET_ID;
const GCP_EMAIL    = process.env.GOOGLE_CLIENT_EMAIL;
const GCP_KEY      = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

const ZD_BASE = `https://${ZD_SUBDOMAIN}.zendesk.com`;
const ZD_AUTH = 'Basic ' + Buffer.from(`${ZD_EMAIL}/token:${ZD_TOKEN}`).toString('base64');

// ── Zendesk field IDs ─────────────────────────────────────────────────────
const TICKET_TYPE_FIELD_ID = 1260812300370;

// Ticket Type field values → display names
const TICKET_TYPES = {
  'main_order':                   'Main Order',
  'ra':                           'Registered Agent',
  'va':                           'Virtual Address',
  'annual_report':                'Annual Report',
  'ein':                          'EIN',
  'amendment':                    'Amendment',
  'reinstatement':                'Reinstatement',
  'domain_and_email':             'Domain and Email',
  'fraud':                        'Fraud',
  'dashboard':                    'Dashboard',
  'dba':                          'DBA',
  '2553_information':             '2553 Information',
  'n/a':                          'N/A',
  'foreign_qualification':        'Foreign Qualification',
  'dissolutions':                 'Dissolutions',
  'blrp':                         'BLRP',
  'trademarks':                   'Lawtrades',
  'cbsattorneys_trademarks':      'Trademarks (Unikel)',
  'certificate_of_good_standing': 'Cert. of Good Standing',
  'business_formation_kit':       'Formation Kit',
  'business_listing':             'Business Listing',
  'third_party_offers':           'Third Party Offers',
  'tax_registration':             'Tax Registration',
  'state_bundle':                 'State Bundle',
  'commercial_client_program':    'Commercial Client',
  'bbb_communication_tp_review':  'BBB / Trustpilot',
  'business_contract_templates':  'Contract Templates',
};

// ── Team roster ───────────────────────────────────────────────────────────
const AGENTS = [
  { name: 'Alex',       email: 'alejandro.i@incfile.com',  supervisor: 'Alberto R' },
  { name: 'Angie',      email: 'angela.a@bizee.com',        supervisor: 'Mario Z'   },
  { name: 'Aris',       email: 'damaris.g@bizee.com',       supervisor: 'Jewel F'   },
  { name: 'Axel',       email: 'isai.g@bizee.com',          supervisor: 'Mario Z'   },
  { name: 'Cesar',      email: 'cesar.c@incfile.com',       supervisor: 'Diana O'   },
  { name: 'Christine',  email: 'christa.n@bizee.com',       supervisor: 'Mario Z'   },
  { name: 'David',      email: 'david.h@bizee.com',         supervisor: 'Mario Z'   },
  { name: 'Dayanira O', email: 'dayanira.o@incfile.com',    supervisor: 'Diana O'   },
  { name: 'Frank',      email: 'fernando.b@bizee.com',      supervisor: 'Mario Z'   },
  { name: 'Fred',       email: 'fernando.t@bizee.com',      supervisor: 'Jose H'    },
  { name: 'Gabriel',    email: 'carlos.b@bizee.com',        supervisor: 'Jose H'    },
  { name: 'Gus',        email: 'agustin.a@bizee.com',       supervisor: 'Jose H'    },
  { name: 'Hilary',     email: 'jamie.v@incfile.com',       supervisor: 'Alberto R' },
  { name: 'Jazmin',     email: 'carolina.j@bizee.com',      supervisor: 'Diana O'   },
  { name: 'Joe',        email: 'joel.s@bizee.com',          supervisor: 'Jewel F'   },
  { name: 'Leah',       email: 'lea.c@bizee.com',           supervisor: 'Jewel F'   },
  { name: 'Lesley',     email: 'luise.k@bizee.com',         supervisor: 'Jose H'    },
  { name: 'Mariana',    email: 'mariana.g@incfile.com',     supervisor: 'Jewel F'   },
  { name: 'Mina',       email: 'ximena.c@incfile.com',      supervisor: 'Diana O'   },
  { name: 'Odeth',      email: 'odeth.r@incfile.com',       supervisor: 'Jewel F'   },
  { name: 'Oliver C.',  email: 'oliver.c@incfile.com',      supervisor: 'Jewel F'   },
  { name: 'Oliver O',   email: 'oliver.o@incfile.com',      supervisor: 'Diana O'   },
  { name: 'Polly',      email: 'paola.c@bizee.com',         supervisor: 'Jose H'    },
  { name: 'Romeo',      email: 'roman.f@bizee.com',         supervisor: 'Mario Z'   },
  { name: 'Roy',        email: 'roy.c@incfile.com',         supervisor: 'Alberto R' },
  { name: 'Samantha',   email: 'samantha.w@bizee.com',      supervisor: 'Jose H'    },
  { name: 'Venancio',   email: 'venancio.s@incfile.com',    supervisor: 'Jose H'    },
  { name: 'Yunueth',    email: 'yunueth.r@incfile.com',     supervisor: 'Diana O'   },
];

// Fast lookup: lowercase email → agent
const AGENT_BY_EMAIL = {};
AGENTS.forEach(a => { AGENT_BY_EMAIL[a.email.toLowerCase()] = a; });

// ── Google Auth (WebCrypto — matches all working bots) ────────────────────
function stripPem(raw) {
  return String(raw || '')
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .replace(/\s/g, '');
}

async function getGoogleAccessToken() {
  const derBuffer = Buffer.from(stripPem(process.env.GOOGLE_PRIVATE_KEY || ''), 'base64');
  const cryptoKey = await subtle.importKey(
    'pkcs8', derBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const now    = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim  = Buffer.from(JSON.stringify({
    iss:   GCP_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  })).toString('base64url');
  const signingInput = `${header}.${claim}`;
  const sigBuffer    = await subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(signingInput));
  const jwt          = `${signingInput}.${Buffer.from(sigBuffer).toString('base64url')}`;
  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('Google auth failed: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Zendesk helpers ───────────────────────────────────────────────────────
async function zdFetch(path) {
  const res = await fetch(`${ZD_BASE}${path}`, {
    headers: { Authorization: ZD_AUTH, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Zendesk ${path} → HTTP ${res.status}`);
  return res.json();
}

async function zdSearchCount(query) {
  const data = await zdFetch(`/api/v2/search/count.json?query=${encodeURIComponent(query)}`);
  return typeof data.count === 'number' ? data.count : 0;
}

// Returns today's date as 'YYYY-MM-DD' in Guadalajara timezone
function getGuadalajaraDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Mexico_City',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const p = {};
  parts.forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

function getDayName() {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Mexico_City',
    weekday: 'long',
  });
}

// Fetch ticket queue counts for SOD / EOD snapshot
async function fetchQueueCounts() {
  // Use view count API to match exactly what supervisors see in Zendesk.
  // 1260869268789 = Unassigned Tickets (all - by date)
  // 114130848912  = Unassigned Tickets (Round Robin)
  // 360199604211  = All Open
  const viewData = await zdFetch('/api/v2/views/count_many.json?ids=1260869268789,114130848912,360199604211');
  const viewCounts = {};
  (viewData.view_counts || []).forEach(v => {
    viewCounts[String(v.view_id)] = typeof v.value === 'number' ? v.value : 0;
  });
  return {
    unassignedDate: viewCounts['1260869268789'] ?? 0,
    unassignedRR:   viewCounts['114130848912']  ?? 0,
    open:           viewCounts['360199604211']  ?? 0,
  };
}

// Returns true if an ISO timestamp falls within 8:00 AM - 5:00 PM Guadalajara time.
// Used to reclassify after-hours chats as emails.
function isBusinessHoursGDL(isoTimestamp) {
  if (!isoTimestamp) return true; // default to in-hours if unknown
  const d = new Date(isoTimestamp);
  const hour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Mexico_City',
      hour: 'numeric',
      hour12: false,
    }).format(d),
    10
  );
  return hour >= 8 && hour < 17;
}

// Agents designated to handle live chats.
// Only these agents get messaging tickets counted as chats.
// Everyone else's messaging tickets count as emails.
const CHAT_AGENTS = new Set([
  'casandra.m@incfile.com',
  'christa.n@bizee.com',
  'odeth.r@incfile.com',
  'ximena.c@incfile.com',
  'cesar.c@incfile.com',
  'alejandro.i@incfile.com',
  'yunueth.r@incfile.com',
  'mariana.g@incfile.com',
  'dayanira.o@incfile.com',
  'oliver.o@incfile.com',
  'venancio.s@incfile.com',
  'diana.o@incfile.com',
]);

// Fetch ALL tickets solved today (paginated, up to 2000)
async function fetchSolvedToday() {
  const date    = getGuadalajaraDate();
  const tickets = [];
  let   url     = `${ZD_BASE}/api/v2/search.json?query=${encodeURIComponent(
    `type:ticket status:solved solved>=${date}`
  )}&per_page=100`;
  let guard = 0;
  while (url && guard < 20) {
    guard++;
    const res = await fetch(url, { headers: { Authorization: ZD_AUTH, Accept: 'application/json' } });
    if (!res.ok) { console.error('[ZD search] HTTP', res.status); break; }
    const data = await res.json();
    tickets.push(...(data.results || []));
    url = data.next_page || null;
  }
  console.log(`[ZD] Fetched ${tickets.length} solved tickets for ${date}`);
  return tickets;
}

// Batch-resolve assignee IDs → emails
async function resolveAssigneeEmails(tickets) {
  const ids = [...new Set(
    tickets.filter(t => t.assignee_id).map(t => String(t.assignee_id))
  )];
  const map = {};
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const data = await zdFetch(`/api/v2/users/show_many.json?ids=${batch.join(',')}`);
      (data.users || []).forEach(u => {
        if (u && u.id && u.email) map[String(u.id)] = u.email.toLowerCase();
      });
    } catch (e) { console.error('[ZD users]', e.message); }
  }
  return map;
}

// Group solved tickets into per-agent stats and ticket-type breakdown
function analyzeTickets(tickets, idToEmail) {
  // Initialize stats for all known agents
  const agentStats = {};
  AGENTS.forEach(a => {
    agentStats[a.email.toLowerCase()] = {
      name:       a.name,
      email:      a.email,
      supervisor: a.supervisor,
      calls:      0,
      chats:      0,
      emails:     0,
      sales:      0,
    };
  });

  const typeCount = {};

  // Track channel distribution for debugging chat detection
  const channelDist = {};

  for (const t of tickets) {
    const rawCh = (t.via && t.via.channel) || '(none)';
    channelDist[rawCh] = (channelDist[rawCh] || 0) + 1;

    // ── Per-agent channel breakdown ──
    const assigneeEmail = idToEmail[String(t.assignee_id)] || null;
    if (assigneeEmail) {
      // Create a dynamic entry for agents not in the AGENTS list (supervisors, QA, etc.)
      if (!agentStats[assigneeEmail]) {
        const knownAgent = AGENT_BY_EMAIL[assigneeEmail];
        agentStats[assigneeEmail] = {
          name:       knownAgent ? knownAgent.name : assigneeEmail.split('@')[0],
          email:      assigneeEmail,
          supervisor: knownAgent ? knownAgent.supervisor : '',
          calls:      0,
          chats:      0,
          emails:     0,
          sales:      0,
        };
      }
      const channel = (t.via && t.via.channel) || '';
      const ch = channel.toLowerCase();
      const isChat = ch === 'chat' || ch === 'messaging' || ch === 'native_messaging' ||
        ch === 'sunshine_conversations_api' ||
        ch.includes('chat') || ch.includes('messag');
      const isChatAgent = CHAT_AGENTS.has(assigneeEmail.toLowerCase());
      if (ch === 'voice') {
        agentStats[assigneeEmail].calls++;
      } else if (isChat && isChatAgent && isBusinessHoursGDL(t.created_at)) {
        // Count as chat only if: chat channel + designated chat agent + business hours
        agentStats[assigneeEmail].chats++;
      } else {
        // Everything else counts as emails: non-chat agents, after-hours chats, email/web tickets
        agentStats[assigneeEmail].emails++;
      }

      // Track closed sales (cs_closed_sale tag)
      if (Array.isArray(t.tags) && t.tags.includes('cs_closed_sale')) {
        agentStats[assigneeEmail].sales++;
      }
    }  // end if (assigneeEmail)

    // ── Ticket type breakdown ──
    const typeField = (t.custom_fields || []).find(f => f.id === TICKET_TYPE_FIELD_ID);
    const typeVal   = typeField ? typeField.value : null;
    if (typeVal) {
      const label = TICKET_TYPES[typeVal] || typeVal;
      typeCount[label] = (typeCount[label] || 0) + 1;
    }
  }

  return { agentStats, typeCount, channelDist };
}

// ── Google Sheets helpers ─────────────────────────────────────────────────
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

async function sheetsGet(token, range) {
  const url = `${SHEETS_BASE}/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function sheetsAppend(token, range, values) {
  const url = `${SHEETS_BASE}/${SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error('sheetsAppend HTTP ' + res.status);
  return res.json();
}

async function sheetsUpdate(token, range, values) {
  const url = `${SHEETS_BASE}/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method:  'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error('sheetsUpdate HTTP ' + res.status);
  return res.json();
}

// Find 1-indexed row number where column A = today's date in "Daily Queue Log"
async function findTodayRow(token) {
  const date = getGuadalajaraDate();
  const data = await sheetsGet(token, 'Daily Queue Log!A:A');
  const rows = data.values || [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] === date) return i + 1;   // 1-indexed
  }
  return null;
}

// ── Slack helpers ─────────────────────────────────────────────────────────
async function sendSlackDM(text) {
  // Open DM channel with Manny
  const dmRes = await fetch('https://slack.com/api/conversations.open', {
    method:  'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ users: MANNY_ID }),
  });
  const dm = await dmRes.json();
  if (!dm.ok) throw new Error('conversations.open failed: ' + dm.error);

  const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
    method:  'POST',
    headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ channel: dm.channel.id, text, mrkdwn: true }),
  });
  const msg = await msgRes.json();
  if (!msg.ok) throw new Error('chat.postMessage failed: ' + msg.error);
  return msg;
}

function formatDelta(before, after) {
  const diff = after - before;
  if (diff === 0) return `*${after}* (no change)`;
  const arrow = diff < 0 ? `↓${Math.abs(diff)}` : `↑${diff}`;
  return `*${after}* (${arrow})`;
}

// ── SOD Job ───────────────────────────────────────────────────────────────
async function runSOD() {
  console.log('[SOD] Starting...');
  try {
    const counts = await fetchQueueCounts();
    const date   = getGuadalajaraDate();
    const day    = getDayName();

    // Write SOD row to Sheets — columns F–H left empty for EOD to fill
    const token = await getGoogleAccessToken();
    await sheetsAppend(token, 'Daily Queue Log!A:H', [[
      date, day,
      counts.unassignedDate, counts.unassignedRR, counts.open,
      '', '', '',
    ]]);
    console.log('[SOD] Sheets updated');

    // Slack DM
    const msg = [
      `🌅 *SOD — ${day}, ${date}*`,
      '',
      `🎫 *Ticket Queue at 9:00 AM*`,
      `  Unassigned (by date):    *${counts.unassignedDate}*`,
      `  Unassigned (round robin): *${counts.unassignedRR}*`,
      `  Open:                    *${counts.open}*`,
    ].join('\n');

    await sendSlackDM(msg);
    console.log('[SOD] DM sent to Manny');
  } catch (e) {
    console.error('[SOD] Error:', e.message);
    try { await sendSlackDM(`❌ SOD job failed: ${e.message}`); } catch {}
  }
}

// ── EOD Job ───────────────────────────────────────────────────────────────
async function runEOD() {
  console.log('[EOD] Starting...');
  try {
    // 1. Queue snapshot
    const counts = await fetchQueueCounts();
    const date   = getGuadalajaraDate();
    const day    = getDayName();

    // 2. Solved tickets analysis
    const tickets    = await fetchSolvedToday();
    const idToEmail  = await resolveAssigneeEmails(tickets);
    const { agentStats, typeCount, channelDist } = analyzeTickets(tickets, idToEmail);

    // 3. Write to Sheets
    const token  = await getGoogleAccessToken();

    // 3a. Update Daily Queue Log: fill in EOD columns (F–H) on today's row
    const rowNum = await findTodayRow(token);
    if (rowNum) {
      await sheetsUpdate(token, `Daily Queue Log!F${rowNum}:H${rowNum}`, [[
        counts.unassignedDate, counts.unassignedRR, counts.open,
      ]]);
    } else {
      // SOD row missing — create a full row
      await sheetsAppend(token, 'Daily Queue Log!A:H', [[
        date, day, '', '', '',
        counts.unassignedDate, counts.unassignedRR, counts.open,
      ]]);
    }

    // 3b. Agent Daily Stats: one row per agent with any activity
    const activeAgents = AGENTS
      .map(a => {
        const s = agentStats[a.email.toLowerCase()];
        return s ? { ...s } : null;
      })
      .filter(s => s && (s.calls + s.chats + s.emails) > 0)
      .sort((a, b) => (b.calls + b.chats + b.emails) - (a.calls + a.chats + a.emails));

    if (activeAgents.length) {
      const rows = activeAgents.map(s => [
        date, s.name, s.email, s.supervisor,
        s.calls, s.chats, s.emails,
        s.calls + s.chats + s.emails,
        s.sales,
      ]);
      await sheetsAppend(token, 'Agent Daily Stats!A:I', rows);
      console.log(`[EOD] Wrote ${rows.length} agent rows`);
    }

    // 3c. Ticket Type Log: one row per type
    const typeRows = Object.entries(typeCount)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => [date, type, count]);
    if (typeRows.length) {
      await sheetsAppend(token, 'Ticket Type Log!A:C', typeRows);
      console.log(`[EOD] Wrote ${typeRows.length} type rows`);
    }

    // 4. Build Slack DM

    // Try to read SOD counts from the sheet for the delta display
    let sodCounts = null;
    if (rowNum) {
      try {
        const sodData = await sheetsGet(token, `Daily Queue Log!C${rowNum}:E${rowNum}`);
        const row = (sodData.values || [[]])[0];
        if (row && row.length >= 3) {
          sodCounts = {
            unassignedDate: Number(row[0]) || 0,
            unassignedRR:   Number(row[1]) || 0,
            open:           Number(row[2]) || 0,
          };
        }
      } catch (e) { console.log('[EOD] Could not read SOD row:', e.message); }
    }

    const lines = [
      `📊 *EOD Report — ${day}, ${date}*`,
      '',
      `🎫 *Ticket Queue*`,
    ];

    if (sodCounts) {
      lines.push(`  Unassigned (by date):    ${formatDelta(sodCounts.unassignedDate, counts.unassignedDate)}`);
      lines.push(`  Unassigned (round robin): ${formatDelta(sodCounts.unassignedRR, counts.unassignedRR)}`);
      lines.push(`  Open:                    ${formatDelta(sodCounts.open, counts.open)}`);
    } else {
      lines.push(`  Unassigned (by date):    *${counts.unassignedDate}*`);
      lines.push(`  Unassigned (round robin): *${counts.unassignedRR}*`);
      lines.push(`  Open:                    *${counts.open}*`);
    }

    // Agent activity table
    lines.push('');
    lines.push(`📞 *Agent Activity Today* — ${tickets.length} tickets solved total`);

    if (activeAgents.length === 0) {
      lines.push('  _No solved tickets attributed to CS agents today._');
    } else {
      // Calculate totals line
      const totCalls  = activeAgents.reduce((s, a) => s + a.calls,  0);
      const totChats  = activeAgents.reduce((s, a) => s + a.chats,  0);
      const totEmails = activeAgents.reduce((s, a) => s + a.emails, 0);
      const totSales  = activeAgents.reduce((s, a) => s + a.sales,  0);
      const maxName   = Math.max(...activeAgents.map(a => a.name.length));

      activeAgents.forEach(s => {
        const total    = s.calls + s.chats + s.emails;
        const salesStr = s.sales > 0 ? `  🏆${s.sales}` : '';
        lines.push(`  ${s.name.padEnd(maxName)}  📞${String(s.calls).padStart(3)}  💬${String(s.chats).padStart(3)}  📧${String(s.emails).padStart(3)}  _(${total})_${salesStr}`);
      });

      lines.push(`  ${'—'.repeat(maxName + 28)}`);
      lines.push(`  ${'TOTAL'.padEnd(maxName)}  📞${String(totCalls).padStart(3)}  💬${String(totChats).padStart(3)}  📧${String(totEmails).padStart(3)}${totSales > 0 ? `  🏆${totSales} sales` : ''}`);
    }

    // Ticket type breakdown
    const topTypes = Object.entries(typeCount).sort((a, b) => b[1] - a[1]);
    if (topTypes.length) {
      lines.push('');
      lines.push('🏷️ *Ticket Types Today*');
      const maxType = Math.max(...topTypes.map(([t]) => t.length));
      topTypes.forEach(([type, count]) => {
        lines.push(`  ${type.padEnd(maxType)}  *${count}*`);
      });
    }

    await sendSlackDM(lines.join('\n'));
    console.log('[EOD] DM sent to Manny');

  } catch (e) {
    console.error('[EOD] Error:', e.message);
    try { await sendSlackDM(`❌ EOD job failed: ${e.message}`); } catch {}
  }
}

// ── Cron schedule (Guadalajara timezone) ─────────────────────────────────
cron.schedule('0 8 * * 1-5',  runSOD, { timezone: 'America/Mexico_City' });
cron.schedule('0 17 * * 1-5', runEOD, { timezone: 'America/Mexico_City' });

// Pre-warm /today-stats cache every 5 min during business hours (8 AM - 6 PM)
// so KB widget responds instantly instead of waiting for on-demand fetch.
// Fetch per-agent call counts from Zendesk Talk stats API.
// Returns {email: {calls, name}} for all agents with calls today.
// This is the authoritative source for call counts — matches the Talk report
// and never decreases since it counts calls accepted, not solved voice tickets.

async function warmTodayStatsCache() {
  try {
    const tickets   = await fetchSolvedToday();
    const idToEmail = await resolveAssigneeEmails(tickets);
    const { agentStats, typeCount, channelDist } = analyzeTickets(tickets, idToEmail);

    const agentRows = {};
    Object.entries(agentStats).forEach(([email, s]) => {
      const total = s.calls + s.chats + s.emails;
      if (total > 0 || s.sales > 0) {
        agentRows[email] = {
          name:       s.name,
          supervisor: s.supervisor,
          calls:      s.calls,
          chats:      s.chats,
          emails:     s.emails,
          sales:      s.sales,
          total,
        };
      }
    });
    todayStatsCache = {
      total:       tickets.length,
      typeCounts:  typeCount,
      agentStats:  agentRows,
      channelDist, // temporary debug field — shows raw via.channel distribution
      lastUpdated: new Date().toISOString(),
    };
    todayStatsCacheTime = Date.now();
    console.log(`[today-stats] Cache warmed — ${tickets.length} tickets`);
  } catch (e) {
    console.error('[today-stats] Warm failed:', e.message);
  }
}
cron.schedule('*/5 8-18 * * 1-5', warmTodayStatsCache, { timezone: 'America/Mexico_City' });

// ── Manual trigger endpoints ──────────────────────────────────────────────
app.post('/sod', async (req, res) => {
  res.json({ ok: true, message: 'SOD triggered' });
  runSOD();
});

app.post('/eod', async (req, res) => {
  res.json({ ok: true, message: 'EOD triggered' });
  runEOD();
});

// One-time setup: create 3 tabs, delete default Sheet1, write headers
app.post('/setup', async (req, res) => {
  try {
    const token = await getGoogleAccessToken();

    // Step 1 — create the 3 named tabs via Sheets batchUpdate
    const batchRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [
            { addSheet: { properties: { title: 'Daily Queue Log',   index: 0 } } },
            { addSheet: { properties: { title: 'Agent Daily Stats', index: 1 } } },
            { addSheet: { properties: { title: 'Ticket Type Log',   index: 2 } } },
            { deleteSheet: { sheetId: 0 } },  // remove the default "Sheet1"
          ],
        }),
      }
    );
    const batchData = await batchRes.json();
    if (batchData.error) throw new Error('batchUpdate: ' + JSON.stringify(batchData.error));

    // Step 2 — write column headers to each tab
    await sheetsUpdate(token, 'Daily Queue Log!A1:H1', [[
      'Date', 'Day', 'UA-All SOD', 'UA-New SOD', 'Open SOD',
      'UA-All EOD', 'UA-New EOD', 'Open EOD',
    ]]);
    await sheetsUpdate(token, 'Agent Daily Stats!A1:I1', [[
      'Date', 'Agent', 'Email', 'Supervisor',
      'Calls', 'Chats', 'Emails', 'Total', 'Sales',
    ]]);
    await sheetsUpdate(token, 'Ticket Type Log!A1:C1', [[
      'Date', 'Ticket Type', 'Count',
    ]]);

    res.json({ ok: true, message: '3 tabs created, Sheet1 deleted, headers written.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// One-time endpoint to update sheet headers + clear stale SOD test row
app.post('/fix-headers', async (req, res) => {
  try {
    const token = await getGoogleAccessToken();
    // Update header row with correct column names
    await sheetsUpdate(token, 'Daily Queue Log!A1:H1', [[
      'Date', 'Day',
      'UA-Date SOD', 'UA-RR SOD', 'Open SOD',
      'UA-Date EOD', 'UA-RR EOD', 'Open EOD',
    ]]);
    // Clear data rows (keep header, wipe rows 2 onward)
    await sheetsUpdate(token, 'Daily Queue Log!A2:H100', [
      Array(8).fill(''),
    ]);
    res.json({ ok: true, message: 'Headers updated and data rows cleared.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// /today-stats — KB widget data source (CORS-enabled, cached 5 min)
let todayStatsCache     = null;
let todayStatsCacheTime = 0;
const TODAY_STATS_TTL   = 5 * 60 * 1000;

app.get('/today-stats', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  try {
    const now = Date.now();
    if (todayStatsCache && (now - todayStatsCacheTime) < TODAY_STATS_TTL) {
      return res.json(todayStatsCache);
    }
    const tickets   = await fetchSolvedToday();
    const idToEmail = await resolveAssigneeEmails(tickets);
    const { agentStats, typeCount, channelDist } = analyzeTickets(tickets, idToEmail);

    // Build clean response: only agents with activity
    const agentRows = {};
    Object.entries(agentStats).forEach(([email, s]) => {
      const total = s.calls + s.chats + s.emails;
      if (total > 0 || s.sales > 0) {
        agentRows[email] = {
          name:   s.name,
          supervisor: s.supervisor,
          calls:  s.calls,
          chats:  s.chats,
          emails: s.emails,
          sales:  s.sales,
          total,
        };
      }
    });

    todayStatsCache = {
      total:      tickets.length,
      typeCounts: typeCount,
      agentStats: agentRows,
      lastUpdated: new Date().toISOString(),
    };
    todayStatsCacheTime = now;
    res.json(todayStatsCache);
  } catch (e) {
    console.error('[today-stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, bot: 'ticket-master-bot' }));

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[ticket-master-bot] Listening on port ${PORT}`);
  // Pre-warm today-stats cache immediately on startup so KB widget loads instantly
  warmTodayStatsCache().catch(e => console.error('[startup warm]', e.message));
});

