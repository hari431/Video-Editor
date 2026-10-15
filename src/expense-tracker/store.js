import path from 'node:path';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';

const DATA_DIR = path.resolve(process.cwd(), 'data', 'private');
const DATA_FILE = path.join(DATA_DIR, 'expense-tracker.json');
const MAX_STORE_BYTES = 5 * 1024 * 1024;
export const VALID_TRANSACTION_STATUSES = Object.freeze(['Unknown', 'Pending', 'Received', 'Paid', 'Invested', 'Transferred']);

export function getRollingCutoffMonth(refDate = new Date()) {
  const d = new Date(refDate);
  if (isNaN(d.getTime())) return '1970-01';
  let y = d.getFullYear();
  let m = d.getMonth();
  m -= 3;
  if (m < 0) {
    m += 12;
    y -= 1;
  }
  const mm = String(m + 1).padStart(2, '0');
  return `${y}-${mm}`;
}

export function isHistoricalMonthLocked(monthStr, refDate = new Date()) {
  if (!monthStr || typeof monthStr !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthStr)) return false;
  const cutoff = getRollingCutoffMonth(refDate);
  return monthStr < cutoff;
}

export function getCurrentMonthStr(refDate = new Date()) {
  const d = new Date(refDate);
  if (isNaN(d.getTime())) return new Date().toISOString().slice(0, 7);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function isFutureMonth(monthStr, refDate = new Date()) {
  if (!monthStr || typeof monthStr !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthStr)) return false;
  return monthStr > getCurrentMonthStr(refDate);
}

export function resetFutureMonth(data, monthStr, personName, refDate = new Date()) {
  if (!isFutureMonth(monthStr, refDate)) {
    throw new Error(`Reset is allowed only for future months (${monthStr} is not a future month).`);
  }
  if (!data || typeof data !== 'object' || !data.months) return data;
  const monthRecord = data.months[monthStr];
  if (!monthRecord) return data;

  if (personName) {
    if (monthRecord.people && monthRecord.people[personName]) {
      monthRecord.people[personName] = { income: [], expenses: [] };
    }
  } else {
    monthRecord.people = {};
  }
  return data;
}

export function getPreviousMonthStr(monthStr) {
  if (!monthStr || typeof monthStr !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthStr)) return null;
  const [yStr, mStr] = monthStr.split('-');
  let y = Number(yStr);
  let m = Number(mStr) - 1;
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function copyPreviousMonth(data, targetMonthStr) {
  if (isHistoricalMonthLocked(targetMonthStr)) throw new Error(`Target month ${targetMonthStr} is locked and read-only.`);
  const prevMonthStr = getPreviousMonthStr(targetMonthStr);
  if (!prevMonthStr) throw new Error('Invalid target month.');
  
  data.months ||= {};
  const prevRecord = data.months[prevMonthStr];
  if (!prevRecord) throw new Error(`No records exist for previous month (${prevMonthStr}) to copy from.`);
  
  data.months[targetMonthStr] ||= { people: {}, bankBalances: [], brokerFunds: [] };
  const targetRecord = data.months[targetMonthStr];
  targetRecord.people ||= {};
  targetRecord.bankBalances ||= [];
  targetRecord.brokerFunds ||= [];

  for (const [person, p] of Object.entries(prevRecord.people || {})) {
    targetRecord.people[person] ||= { income: [], expenses: [] };
    const tp = targetRecord.people[person];
    tp.income ||= [];
    tp.expenses ||= [];

    for (const type of ['income', 'expenses']) {
      for (const entry of p[type] || []) {
        const exists = tp[type].some(e => e.description === entry.description && Number(e.amount) === Number(entry.amount));
        if (!exists) {
          tp[type].push({
            description: entry.description,
            category: entry.category || 'Other',
            amount: Number(entry.amount) || 0,
            note: entry.note || '',
            status: 'Pending'
          });
        }
      }
    }
  }

  for (const broker of prevRecord.brokerFunds || []) {
    const exists = targetRecord.brokerFunds.some(b => b.person === broker.person && b.description === broker.description);
    if (!exists) {
      targetRecord.brokerFunds.push({
        person: broker.person || 'You',
        account: broker.account || broker.description,
        description: broker.description,
        amount: Number(broker.amount) || 0,
        note: broker.note || '',
        status: 'Pending'
      });
    }
  }

  return data;
}

export const DEFAULT_TEMPLATES = Object.freeze([
  { id: 'tpl_salary', description: 'Salary', type: 'income', category: 'Other', person: 'You' },
  { id: 'tpl_rent', description: 'House Rent', type: 'expenses', category: 'Rent', person: 'You' },
  { id: 'tpl_mf_stocks', description: 'Mutual Funds & Stocks', type: 'expenses', category: 'Investments', person: 'You' },
  { id: 'tpl_tax', description: 'Tax', type: 'expenses', category: 'Other', person: 'You' },
  { id: 'tpl_misc', description: 'Misc Exp', type: 'expenses', category: 'Other', person: 'You' },
  { id: 'tpl_insurance', description: 'Insurance', type: 'expenses', category: 'Other', person: 'You' },
  { id: 'tpl_gold', description: 'Gold(Mother Acc)', type: 'expenses', category: 'Investments', person: 'You' }
]);

const DEFAULT_DATA = Object.freeze({
  version: 1,
  people: ['You', 'Chandu'],
  categories: ['Rent', 'Groceries', 'Utilities', 'Travel', 'Medical', 'Shopping', 'Investments', 'Other'],
  accounts: ['Zerodha - Account 1', 'Zerodha - Account 2', 'Zerodha - Account 3', 'INDmoney'],
  templates: DEFAULT_TEMPLATES,
  months: {},
  imports: []
});

export function isLocalExpenseTrackerRequest(req) {
  const host = String(req.get?.('host') || '').split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  const remote = String(req.socket?.remoteAddress || '').toLowerCase();
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const localRemote = remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1';
  return localHost && localRemote;
}
export function isExpenseTrackerAvailable(env = process.env) {
  return env.NODE_ENV === 'development' && typeof env.EXPENSE_TRACKER_PASSCODE === 'string' && env.EXPENSE_TRACKER_PASSCODE.length >= 8;
}

export function safePasscodeEqual(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string' || !candidate || !expected) return false;
  // Compare fixed-size hashes to avoid leaking passcode length through timing.
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  const { createHash, timingSafeEqual } = requireCrypto();
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
function requireCrypto() {
  // Static imports keep this module synchronous and work on supported Node 22+.
  return cryptoModule;
}
import * as cryptoModule from 'node:crypto';

function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_DATA));
}
export async function readExpenseData() {
  try {
    const stat = await readFile(DATA_FILE);
    if (stat.length > MAX_STORE_BYTES) throw new Error('Expense Tracker local data exceeds the allowed size.');
    const parsed = JSON.parse(stat.toString('utf8'));
    if (!parsed || parsed.version !== 1 || !parsed.months || typeof parsed.months !== 'object') throw new Error('Expense Tracker data format is invalid.');
    return { ...cloneDefaults(), ...parsed };
  } catch (err) {
    if (err.code === 'ENOENT') return cloneDefaults();
    throw err;
  }
}
export async function writeExpenseData(value) {
  const data = validateExpenseData(value);
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const serialized = JSON.stringify(data, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STORE_BYTES) throw new Error('Expense Tracker local data exceeds the 5 MB limit.');
  const temp = path.join(DATA_DIR, `.expense-tracker-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  await rename(temp, DATA_FILE);
  return data;
}
export function validateExpenseData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid expense data.');
  const people = Array.isArray(value.people) ? value.people.map(cleanLabel).filter(Boolean).slice(0, 20) : ['Household'];
  const categories = Array.isArray(value.categories) ? value.categories.map(cleanLabel).filter(Boolean).slice(0, 100) : cloneDefaults().categories;
  const suppliedAccounts = Array.isArray(value.accounts) ? value.accounts.map(cleanLabel).filter(Boolean).slice(0, 100) : [];
  const accounts = suppliedAccounts.length ? suppliedAccounts : cloneDefaults().accounts;
  if (!people.length || !categories.length) throw new Error('At least one person and category are required.');
  const months = value.months && typeof value.months === 'object' && !Array.isArray(value.months) ? value.months : {};
  if (Object.keys(months).length > 120) throw new Error('Too many monthly records.');
  for (const [month, record] of Object.entries(months)) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !record || typeof record !== 'object') throw new Error('Invalid month record.');
    for (const person of Object.keys(record.people || {})) {
      if (!people.includes(person)) throw new Error('Monthly record contains an unknown person.');
      const p = record.people[person];
      if (!p || typeof p !== 'object') throw new Error('Invalid person record.');
      p.income = normalizeEntries(p.income, categories);
      p.expenses = normalizeEntries(p.expenses, categories);
    }
    record.bankBalances = Array.isArray(record.bankBalances) ? record.bankBalances.slice(0, 100).map(row => ({
      account: cleanLabel(row.account).slice(0, 80),
      opening: finiteAmount(row.opening),
      closing: finiteAmount(row.closing),
      note: cleanLabel(row.note).slice(0, 250)
    })) : [];
    record.brokerFunds = Array.isArray(record.brokerFunds) ? record.brokerFunds.slice(0, 100).map(row => ({
      person: cleanLabel(row.person || 'Household').slice(0, 80),
      account: cleanLabel(row.account || row.description).slice(0, 80),
      description: cleanLabel(row.description || row.account).slice(0, 160),
      amount: finiteAmount(row.amount),
      note: cleanLabel(row.note).slice(0, 250),
      status: VALID_TRANSACTION_STATUSES.includes(row.status) ? row.status : 'Unknown'
    })) : [];
  }
  const suppliedTemplates = Array.isArray(value.templates) ? value.templates.map((tpl, i) => ({
    id: cleanLabel(tpl.id || `tpl_${i + 1}`).slice(0, 80),
    description: cleanLabel(tpl.description).slice(0, 160),
    type: ['income', 'expenses', 'brokerFunds'].includes(tpl.type) ? tpl.type : 'expenses',
    category: categories.includes(cleanLabel(tpl.category)) ? cleanLabel(tpl.category) : 'Other',
    person: people.includes(cleanLabel(tpl.person)) ? cleanLabel(tpl.person) : (people[0] || 'You')
  })).filter(t => t.description) : [];
  const templates = suppliedTemplates.length ? suppliedTemplates : DEFAULT_TEMPLATES.map(t => ({ ...t }));

  const imports = Array.isArray(value.imports) ? value.imports.slice(-200).map(row => ({
    source: row.source === 'INDmoney' ? 'INDmoney' : 'Zerodha',
    assetType: row.assetType === 'mutualFund' ? 'mutualFund' : 'stock',
    currency: row.currency === 'USD' ? 'USD' : 'INR',
    importedAt: String(row.importedAt || '').slice(0, 40),
    month: /^\d{4}-(0[1-9]|1[0-2])$/.test(row.month) ? row.month : '',
    rows: Array.isArray(row.rows) ? row.rows.slice(0, 5000).map(item => ({
      symbol: cleanLabel(item.symbol).slice(0, 150),
      isin: cleanLabel(item.isin).slice(0, 20),
      currency: item.currency === 'USD' ? 'USD' : 'INR',
      quantity: finiteQuantity(item.quantity),
      units: finiteQuantity(item.units ?? item.quantity),
      averagePrice: finiteAmount(item.averagePrice),
      currentPrice: finiteAmount(item.currentPrice),
      invested: finiteAmount(item.invested),
      currentValue: finiteAmount(item.currentValue),
      purpose: cleanLabel(item.purpose).slice(0, 250),
      account: cleanLabel(item.account).slice(0, 100)
    })) : []
  })) : [];
  return { version: 1, people, categories, accounts, templates, months, imports };
}
function cleanLabel(value) { return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120); }
function finiteAmount(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new Error('Amounts must be valid finite numbers.');
  return Math.round(n * 100) / 100;
}
function finiteQuantity(value) {
  if (value === '' || value === null || value === undefined) return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw new Error('Units must be valid finite numbers.');
  return Math.round(n * 1e6) / 1e6;
}
function normalizeEntries(entries, categories) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 500).map(row => ({
    description: cleanLabel(row.description).slice(0, 160),
    category: categories.includes(cleanLabel(row.category)) ? cleanLabel(row.category) : 'Other',
    amount: finiteAmount(row.amount),
    note: cleanLabel(row.note).slice(0, 250),
    status: VALID_TRANSACTION_STATUSES.includes(row.status) ? row.status : 'Unknown'
  }));
}

export function prefillMonthFromTemplates(data, monthStr) {
  if (isHistoricalMonthLocked(monthStr)) return data;
  data.months ||= {};
  data.months[monthStr] ||= { people: {}, bankBalances: [], brokerFunds: [] };
  const m = data.months[monthStr];
  m.people ||= {};

  const templates = Array.isArray(data.templates) && data.templates.length ? data.templates : DEFAULT_TEMPLATES;

  for (const tpl of templates) {
    const person = tpl.person && data.people.includes(tpl.person) ? tpl.person : (data.people[0] || 'You');
    m.people[person] ||= { income: [], expenses: [] };
    const p = m.people[person];

    if (tpl.type === 'brokerFunds') {
      m.brokerFunds ||= [];
      const exists = m.brokerFunds.some(b => b.person === person && b.description === tpl.description);
      if (!exists) {
        m.brokerFunds.push({
          person,
          account: tpl.description,
          description: tpl.description,
          amount: 0,
          note: '',
          status: 'Pending'
        });
      }
    } else if (tpl.type === 'income' || tpl.type === 'expenses') {
      p[tpl.type] ||= [];
      const exists = p[tpl.type].some(e => e.description === tpl.description);
      if (!exists) {
        p[tpl.type].push({
          description: tpl.description,
          category: tpl.category || 'Other',
          amount: 0,
          note: '',
          status: 'Pending'
        });
      }
    }
  }
  return data;
}
export function parseBrokerCsv(csv, source, assetType = 'stock', accountOverride = '') {
  if (typeof csv !== 'string' || csv.length > 1024 * 1024) throw new Error('Upload or paste holdings data up to 1 MB per preview.');
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim()).slice(0, 10001);
  if (lines.length < 2) throw new Error('CSV must contain a header and at least one data row.');
  const parseLine = line => {
    const out=[]; let cell='', quoted=false;
    for (let i=0;i<line.length;i++) {
      const ch=line[i];
      if (ch === '"' && quoted && line[i+1] === '"') { cell+='"'; i++; }
      else if (ch === '"') quoted=!quoted;
      else if (ch === ',' && !quoted) { out.push(cell.trim()); cell=''; }
      else cell+=ch;
    }
    if (quoted) throw new Error('CSV contains an unclosed quoted field.');
    out.push(cell.trim()); return out;
  };
  // Broker statements can include account metadata and disclaimers before/after the actual table.
  const headerIndex = lines.findIndex(line => {
    const candidate = parseLine(line).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
    return candidate.some(h => ['symbol','stocksymbol','tradingsymbol','instrument','scrip','name','mutualfund','fundname','schemename'].includes(h))
      && candidate.some(h => ['quantity','qty','netquantity','units','availablequantity','balanceunits'].includes(h));
  });
  if (headerIndex < 0) throw new Error('Could not find a holdings table header with instrument and quantity columns.');
  const rawHeaders=parseLine(lines[headerIndex]);
  const headers=rawHeaders.map(h=>h.toLowerCase().replace(/[^a-z0-9]/g,''));
  const currency = rawHeaders.some(h => /\$|\bUSD\b/i.test(h)) ? 'USD' : 'INR';
  const find = (...names) => headers.findIndex(h=>names.includes(h));
  const indexes = {
    symbol: find('symbol','tradingsymbol','stockname','instrument','scrip','name','mutualfund','fundname','schemename','stocksymbol'),
    isin: find('isin','isinno','isinnumber'),
    quantity: find('quantity','qty','netquantity','units','availablequantity','balanceunits'),
    averagePrice: find('averageprice','avgprice','avgprices','buyaverageprice','avgcost','averagecost','averagecostprice','avgcostprice'),
    currentPrice: find('ltp','lastprice','currentprice','marketprice','closingprice','nav','latestnav'),
    invested: find('invested','investedvalue','buyvalue','costvalue','cost','costamount','purchasevalue','totalinvestment'),
    currentValue: find('currentvalue','marketvalue','valuation','presentvalue','marketvaluecurrent','currentamount','totalvalue'),
    account: find('account','accountname','broker','demataccount'),
    purpose: find('purpose','intent','investmentpurpose','notes')
  };
  if (indexes.symbol < 0) throw new Error('Could not identify a symbol/name column. Export a holdings CSV and review the header row.');
  const rows=[];
  for (const line of lines.slice(headerIndex + 1)) {
    const cells=parseLine(line);
    const get=k=>indexes[k]>=0 ? (cells[indexes[k]] ?? '') : '';
    const number=v=> { const n=Number(String(v).replace(/[₹$€£,\s]/g,'')); return Number.isFinite(n) ? n : 0; };
    const symbol=String(get('symbol')).trim();
    if (!symbol) continue;
    const quantity=number(get('quantity')), averagePrice=number(get('averagePrice')), currentPrice=number(get('currentPrice'));
    const invested=number(get('invested')) || quantity*averagePrice;
    const currentValue=number(get('currentValue')) || quantity*currentPrice;
    const isin=String(get('isin')).trim().slice(0,20);
     const inferredFund = /^INF/i.test(isin) || /\b(mutual fund|fund scheme|growth direct|regular plan|direct plan)\b/i.test(symbol);
     const rowAssetType = assetType === 'auto' ? (inferredFund ? 'mutualFund' : 'stock') : (assetType === 'mutualFund' ? 'mutualFund' : 'stock');
     rows.push({symbol,isin,currency,quantity,units:quantity,averagePrice,currentPrice,invested,currentValue,purpose:String(get('purpose')).slice(0,250),account:String(accountOverride || get('account') || source).slice(0,100),assetType:rowAssetType});
  }
  if (!rows.length) throw new Error('No holdings rows were recognized.');
  return rows;
}
