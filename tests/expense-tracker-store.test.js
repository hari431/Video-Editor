import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isExpenseTrackerAvailable,
  isLocalExpenseTrackerRequest,
  safePasscodeEqual,
  parseBrokerCsv,
  validateExpenseData,
  getRollingCutoffMonth,
  isHistoricalMonthLocked,
  getPreviousMonthStr,
  copyPreviousMonth,
  prefillMonthFromTemplates,
  isFutureMonth,
  resetFutureMonth
} from '../src/expense-tracker/store.js';

test('rolling four-month editing window calculates cutoff correctly and enforces read-only state', () => {
  const refDateOct2026 = new Date('2026-10-15T12:00:00Z');
  assert.equal(getRollingCutoffMonth(refDateOct2026), '2026-07');
  assert.equal(isHistoricalMonthLocked('2026-10', refDateOct2026), false); // Current month
  assert.equal(isHistoricalMonthLocked('2026-09', refDateOct2026), false); // M - 1
  assert.equal(isHistoricalMonthLocked('2026-08', refDateOct2026), false); // M - 2
  assert.equal(isHistoricalMonthLocked('2026-07', refDateOct2026), false); // M - 3 (July 2026 editable)
  assert.equal(isHistoricalMonthLocked('2026-06', refDateOct2026), true);  // M - 4 (June 2026 locked)
  assert.equal(isHistoricalMonthLocked('2026-01', refDateOct2026), true);  // Historical locked
  assert.equal(isHistoricalMonthLocked('2026-11', refDateOct2026), false); // Future editable
});

test('rolling window works across year boundaries (e.g., January 2027)', () => {
  const refDateJan2027 = new Date('2027-01-20T12:00:00Z');
  assert.equal(getRollingCutoffMonth(refDateJan2027), '2026-10');
  assert.equal(isHistoricalMonthLocked('2027-01', refDateJan2027), false); // Current
  assert.equal(isHistoricalMonthLocked('2026-12', refDateJan2027), false); // M - 1
  assert.equal(isHistoricalMonthLocked('2026-11', refDateJan2027), false); // M - 2
  assert.equal(isHistoricalMonthLocked('2026-10', refDateJan2027), false); // M - 3 (Oct 2026 editable)
  assert.equal(isHistoricalMonthLocked('2026-09', refDateJan2027), true);  // M - 4 (Sept 2026 locked)
});

test('getPreviousMonthStr calculates preceding month correctly', () => {
  assert.equal(getPreviousMonthStr('2026-10'), '2026-09');
  assert.equal(getPreviousMonthStr('2027-01'), '2026-12');
  assert.equal(getPreviousMonthStr('invalid'), null);
});

test('copyPreviousMonth copies transactions, resets status to Pending, and is idempotent', () => {
  const data = {
    version: 1,
    people: ['You', 'Chandu'],
    categories: ['Rent', 'Other'],
    accounts: [],
    templates: [],
    months: {
      '2026-10': {
        people: {
          You: {
            income: [{ description: 'Salary', amount: 200000, category: 'Other', note: 'Oct salary', status: 'Received' }],
            expenses: [{ description: 'Rent', amount: 25000, category: 'Rent', note: 'Oct rent', status: 'Paid' }]
          }
        },
        bankBalances: [],
        brokerFunds: [
          { person: 'Chandu', account: 'Kite Money', description: 'Kite Money', amount: 20000, note: 'Broker', status: 'Transferred' }
        ]
      }
    },
    imports: []
  };

  // Perform initial copy from 2026-10 to 2026-11
  const updated = copyPreviousMonth(data, '2026-11');
  assert.ok(updated.months['2026-11']);
  
  // Verify source month is completely unchanged
  assert.equal(updated.months['2026-10'].people.You.income[0].status, 'Received');
  assert.equal(updated.months['2026-10'].people.You.expenses[0].status, 'Paid');

  // Verify target month has copied entries with status reset to Pending
  const targetYou = updated.months['2026-11'].people.You;
  assert.equal(targetYou.income.length, 1);
  assert.equal(targetYou.income[0].description, 'Salary');
  assert.equal(targetYou.income[0].amount, 200000);
  assert.equal(targetYou.income[0].status, 'Pending'); // Reset from Received!

  assert.equal(targetYou.expenses.length, 1);
  assert.equal(targetYou.expenses[0].description, 'Rent');
  assert.equal(targetYou.expenses[0].status, 'Pending'); // Reset from Paid!

  assert.equal(updated.months['2026-11'].brokerFunds.length, 1);
  assert.equal(updated.months['2026-11'].brokerFunds[0].status, 'Pending'); // Reset from Transferred!

  // Perform repeated copy attempt to verify idempotency (no duplicates created)
  copyPreviousMonth(updated, '2026-11');
  assert.equal(updated.months['2026-11'].people.You.income.length, 1);
  assert.equal(updated.months['2026-11'].people.You.expenses.length, 1);
  assert.equal(updated.months['2026-11'].brokerFunds.length, 1);
});

test('prefillMonthFromTemplates adds template descriptions with zero amount and Pending status', () => {
  const data = {
    version: 1,
    people: ['You'],
    categories: ['Rent', 'Other'],
    accounts: [],
    templates: [
      { id: 't1', description: 'Salary', type: 'income', category: 'Other', person: 'You' },
      { id: 't2', description: 'House Rent', type: 'expenses', category: 'Rent', person: 'You' }
    ],
    months: {},
    imports: []
  };

  const updated = prefillMonthFromTemplates(data, '2026-11');
  const targetYou = updated.months['2026-11'].people.You;
  assert.equal(targetYou.income.length, 1);
  assert.equal(targetYou.income[0].description, 'Salary');
  assert.equal(targetYou.income[0].amount, 0);
  assert.equal(targetYou.income[0].status, 'Pending');

  assert.equal(targetYou.expenses.length, 1);
  assert.equal(targetYou.expenses[0].description, 'House Rent');
  assert.equal(targetYou.expenses[0].amount, 0);

  // Repeated call does not duplicate
  prefillMonthFromTemplates(updated, '2026-11');
  assert.equal(targetYou.income.length, 1);
  assert.equal(targetYou.expenses.length, 1);
});

test('isFutureMonth correctly identifies future months relative to current date', () => {
  const refDate = new Date('2026-10-15T12:00:00Z');
  assert.equal(isFutureMonth('2026-11', refDate), true);
  assert.equal(isFutureMonth('2026-12', refDate), true);
  assert.equal(isFutureMonth('2027-01', refDate), true);
  assert.equal(isFutureMonth('2026-10', refDate), false); // Current month
  assert.equal(isFutureMonth('2026-09', refDate), false); // Past month
});

test('resetFutureMonth clears selected person transactions in future month and rejects non-future months', () => {
  const refDate = new Date('2026-10-15T12:00:00Z');
  const data = {
    version: 1,
    people: ['You', 'Chandu'],
    categories: ['Rent', 'Other'],
    accounts: [],
    templates: [{ id: 't1', description: 'Salary', type: 'income', category: 'Other', person: 'You' }],
    months: {
      '2026-10': {
        people: {
          You: { income: [{ description: 'Oct Salary', amount: 200000, category: 'Other', status: 'Received' }], expenses: [] }
        }
      },
      '2026-11': {
        people: {
          You: { income: [{ description: 'Salary', amount: 200000, category: 'Other', status: 'Pending' }], expenses: [{ description: 'Rent', amount: 25000, category: 'Rent', status: 'Pending' }] },
          Chandu: { income: [{ description: 'Salary', amount: 100000, category: 'Other', status: 'Pending' }], expenses: [] }
        },
        brokerFunds: [{ person: 'Chandu', account: 'Kite', description: 'Kite', amount: 5000, status: 'Pending' }]
      }
    },
    imports: []
  };

  // Attempting to reset current or past month throws
  assert.throws(() => resetFutureMonth(data, '2026-10', 'You', refDate), /Reset is allowed only for future months/);
  assert.throws(() => resetFutureMonth(data, '2026-09', 'You', refDate), /Reset is allowed only for future months/);

  // Resetting future month 2026-11 for person "You"
  resetFutureMonth(data, '2026-11', 'You', refDate);

  // Verify "You" entries in 2026-11 are cleared
  assert.equal(data.months['2026-11'].people.You.income.length, 0);
  assert.equal(data.months['2026-11'].people.You.expenses.length, 0);

  // Verify Chandu entries, current month 2026-10, templates, and broker funds remain completely intact
  assert.equal(data.months['2026-11'].people.Chandu.income.length, 1);
  assert.equal(data.months['2026-10'].people.You.income.length, 1);
  assert.equal(data.templates.length, 1);
  assert.equal(data.months['2026-11'].brokerFunds.length, 1);

  // Verify month can be initialized again after reset
  prefillMonthFromTemplates(data, '2026-11');
  assert.equal(data.months['2026-11'].people.You.income.length, 1);
});

test('feature is available only in development with a sufficiently long configured passcode', () => {
  assert.equal(isExpenseTrackerAvailable({ NODE_ENV: 'development', EXPENSE_TRACKER_PASSCODE: '12345678' }), true);
  assert.equal(isExpenseTrackerAvailable({ NODE_ENV: 'production', EXPENSE_TRACKER_PASSCODE: '12345678' }), false);
  assert.equal(isExpenseTrackerAvailable({ NODE_ENV: 'development', EXPENSE_TRACKER_PASSCODE: '' }), false);
  assert.equal(isExpenseTrackerAvailable({ NODE_ENV: 'development' }), false);
});
test('local request gate requires both loopback host and loopback socket', () => {
  assert.equal(isLocalExpenseTrackerRequest({ get: () => 'localhost:3000', socket: { remoteAddress: '::ffff:127.0.0.1' } }), true);
  assert.equal(isLocalExpenseTrackerRequest({ get: () => 'example.com', socket: { remoteAddress: '::ffff:127.0.0.1' } }), false);
  assert.equal(isLocalExpenseTrackerRequest({ get: () => 'localhost:3000', socket: { remoteAddress: '192.168.1.10' } }), false);
});
test('passcode comparison rejects missing and incorrect values', () => {
  assert.equal(safePasscodeEqual('correct horse', 'correct horse'), true);
  assert.equal(safePasscodeEqual('wrong', 'correct horse'), false);
  assert.equal(safePasscodeEqual('', 'correct horse'), false);
});
test('CSV preview normalizes common holdings headers and derives values', () => {
  const rows = parseBrokerCsv('Symbol,Quantity,Average Price,LTP,Account,Purpose\nABC,2,100,125,Zerodha Demat,Long term', 'Zerodha');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'ABC');
  assert.equal(rows[0].invested, 200);
  assert.equal(rows[0].currentValue, 250);
  assert.equal(rows[0].purpose, 'Long term');
});
test('CSV parser accepts basic rows and rejects malformed data', () => {
  assert.equal(parseBrokerCsv('Symbol,Quantity\nABC,1', 'Zerodha').length, 1);
  assert.throws(() => parseBrokerCsv('Symbol,Quantity\n"ABC,1', 'Zerodha'), /unclosed/i);
  assert.throws(() => parseBrokerCsv('x'.repeat(1024 * 1024 + 1), 'Zerodha'), /1 MB/i);
});
test('store validation rejects invalid month keys and unknown people', () => {
  assert.throws(() => validateExpenseData({ version:1, people:['You'], categories:['Other'], months:{ nope:{} } }), /Invalid month/);
  assert.throws(() => validateExpenseData({ version:1, people:['You'], categories:['Other'], months:{'2026-10':{people:{Chandu:{income:[],expenses:[]}}}} }), /unknown person/);
});
