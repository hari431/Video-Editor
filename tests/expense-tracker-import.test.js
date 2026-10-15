import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';
import { parseSalaryWorkbook, mergeImportRows, maskDatabaseUrl } from '../scripts/import-expense-tracker.js';
import { validateExpenseData } from '../src/expense-tracker/store.js';

test('parseSalaryWorkbook extracts salary income and negative expenses from mock workbook', () => {
  const wb = XLSX.utils.book_new();
  const sheetData = [
    ['', 'My salary', 'Chandu Salary', 'Total Salary'],
    ['', 260353, 103454, ''],
    ['Salary', 207502, 56540, ''],
    ['Loan + Sending to Nandyal', -25000, 0, 'Done'],
    ['Mutual Funds & Stocks', -73000, -17000, 'Done'],
    ['Remaining money', 48684, 12540, '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(wb, ws, 'Jan-2026');

  const parsed = parseSalaryWorkbook(wb);
  assert.equal(parsed.rows.length, 5);

  const salaryYou = parsed.rows.find(r => r.person === 'You' && r.type === 'income');
  assert.equal(salaryYou.amount, 207502);

  const salaryChandu = parsed.rows.find(r => r.person === 'Chandu' && r.type === 'income');
  assert.equal(salaryChandu.amount, 56540);

  const expenseYou = parsed.rows.find(r => r.person === 'You' && r.description === 'Loan + Sending to Nandyal');
  assert.equal(expenseYou.amount, 25000);

  const summarySkipped = parsed.skipped.find(s => s.reason === 'summary row excluded' && s.description === 'Remaining money');
  assert.ok(summarySkipped);
});

test('parseSalaryWorkbook preserves Kite Money as broker funds and excludes non-Kite positive values', () => {
  const wb = XLSX.utils.book_new();
  const sheetData = [
    ['', 'My salary', 'Mutual fund & Date', 'Chandu Salary', 'Total Salary'],
    ['', 343984, '', 497320, ''],
    ['Salary', 220508, '', 109259, ''],
    ['Kite Money', 0, '', 20000, ''],
    ['Other Non Salary Bonus', 5000, '', 0, ''],
    ['Remaining money', 20690, '', -18341, '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  XLSX.utils.book_append_sheet(wb, ws, 'Aug-2026');

  const parsed = parseSalaryWorkbook(wb);
  const incomeRows = parsed.rows.filter(r => r.type === 'income');
  const expenseRows = parsed.rows.filter(r => r.type === 'expenses');
  const brokerRows = parsed.rows.filter(r => r.type === 'brokerFunds');

  assert.equal(incomeRows.length, 2); // 2 salary entries
  assert.equal(expenseRows.length, 0);
  assert.equal(brokerRows.length, 1);

  assert.equal(brokerRows[0].person, 'Chandu');
  assert.equal(brokerRows[0].description, 'Kite Money');
  assert.equal(brokerRows[0].amount, 20000);

  const positiveExcluded = parsed.skipped.find(s => s.reason === 'positive non-salary value skipped' && s.description === 'Other Non Salary Bonus');
  assert.ok(positiveExcluded);
});

test('parseSalaryWorkbook extracts Kite Money records from actual 2026 workbook', () => {
  const fileBuffer = fs.readFileSync(path.resolve(process.cwd(), 'sheets/Expense Tracker - 2026.xlsx'));
  const wb = XLSX.read(fileBuffer, { type: 'buffer', cellFormulas: true, cellDates: true });
  const parsed = parseSalaryWorkbook(wb);

  const incomeRows = parsed.rows.filter(r => r.type === 'income');
  const expenseRows = parsed.rows.filter(r => r.type === 'expenses');
  const brokerRows = parsed.rows.filter(r => r.type === 'brokerFunds');

  assert.equal(incomeRows.length, 20);
  assert.equal(expenseRows.length, 172);
  assert.equal(brokerRows.length, 2);

  const totalIncome = incomeRows.reduce((sum, r) => sum + r.amount, 0);
  const totalExpenses = expenseRows.reduce((sum, r) => sum + r.amount, 0);
  const totalBroker = brokerRows.reduce((sum, r) => sum + r.amount, 0);

  assert.equal(totalIncome, 3765682);
  assert.equal(totalExpenses, 3823070);
  assert.equal(totalBroker, 28031);

  const augKite = brokerRows.find(r => r.month === '2026-08');
  assert.ok(augKite);
  assert.equal(augKite.person, 'Chandu');
  assert.equal(augKite.amount, 20000);

  const septKite = brokerRows.find(r => r.month === '2026-09');
  assert.ok(septKite);
  assert.equal(septKite.person, 'Chandu');
  assert.equal(septKite.amount, 8031);
});

test('mergeImportRows handles idempotency and brokerFunds preservation', () => {
  const initialData = {
    version: 1,
    people: ['You', 'Chandu'],
    categories: ['Rent', 'Groceries', 'Other'],
    accounts: [],
    months: {},
    imports: []
  };

  const rows = [
    { month: '2026-01', person: 'You', type: 'income', description: 'Salary', category: 'Other', amount: 200000, note: 'Imported from Expense Tracker - 2026 workbook' },
    { month: '2026-01', person: 'You', type: 'expenses', description: 'Rent', category: 'Rent', amount: 25000, note: 'Imported from Expense Tracker - 2026 workbook' },
    { month: '2026-08', person: 'Chandu', type: 'brokerFunds', description: 'Kite Money', account: 'Kite Money', amount: 20000, note: 'Imported from Expense Tracker - 2026 workbook' },
    { month: '2026-09', person: 'Chandu', type: 'brokerFunds', description: 'Kite Money', account: 'Kite Money', amount: 8031, note: 'Imported from Expense Tracker - 2026 workbook' }
  ];

  const firstMerge = mergeImportRows(initialData, rows);
  assert.equal(firstMerge.addedCount, 4);
  assert.equal(firstMerge.brokerFundCount, 2);
  assert.equal(firstMerge.duplicateCount, 0);

  assert.equal(firstMerge.data.months['2026-08'].brokerFunds.length, 1);
  assert.equal(firstMerge.data.months['2026-08'].brokerFunds[0].amount, 20000);
  assert.equal(firstMerge.data.months['2026-09'].brokerFunds.length, 1);
  assert.equal(firstMerge.data.months['2026-09'].brokerFunds[0].amount, 8031);

  // Repeat merge with same rows
  const secondMerge = mergeImportRows(firstMerge.data, rows);
  assert.equal(secondMerge.addedCount, 0);
  assert.equal(secondMerge.duplicateCount, 4);
});

test('validateExpenseData retains brokerFunds entries', () => {
  const validated = validateExpenseData({
    version: 1,
    people: ['You', 'Chandu'],
    categories: ['Rent', 'Other'],
    accounts: [],
    months: {
      '2026-08': {
        people: {},
        bankBalances: [],
        brokerFunds: [
          { person: 'Chandu', account: 'Kite Money', description: 'Kite Money', amount: 20000, note: 'Imported' }
        ]
      }
    },
    imports: []
  });

  assert.equal(validated.months['2026-08'].brokerFunds.length, 1);
  assert.equal(validated.months['2026-08'].brokerFunds[0].person, 'Chandu');
  assert.equal(validated.months['2026-08'].brokerFunds[0].amount, 20000);
});

test('maskDatabaseUrl safely redacts credentials in connection URLs', () => {
  assert.equal(maskDatabaseUrl('postgres://admin:secret123@localhost:5432/expense_db'), 'postgres://admin:****@localhost:5432/expense_db');
  assert.equal(maskDatabaseUrl(''), '(not set)');
});
