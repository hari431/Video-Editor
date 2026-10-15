import 'dotenv/config';
import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import XLSX from 'xlsx';
import { readExpenseData, writeExpenseData, closeExpenseTrackerPool } from '../src/expense-tracker/db-store.js';

export const SALARY_IMPORT_NOTE = 'Imported from Expense Tracker - 2026 workbook';

export function parseSalaryWorkbook(workbook) {
  const result = [];
  const skipped = [];
  const monthMap = {
    'jan': '01', 'january': '01',
    'feb': '02', 'february': '02',
    'mar': '03', 'march': '03',
    'apr': '04', 'april': '04',
    'may': '05',
    'jun': '06', 'june': '06',
    'jul': '07', 'july': '07',
    'aug': '08', 'august': '08',
    'sep': '09', 'sept': '09', 'september': '09',
    'oct': '10', 'october': '10',
    'nov': '11', 'november': '11',
    'dec': '12', 'december': '12'
  };

  for (const sheetName of workbook.SheetNames) {
    const match = sheetName.match(/^([A-Za-z]+)[ -]+(20\d{2})$/);
    if (!match) {
      skipped.push({ sheet: sheetName, reason: 'unrecognized month tab format' });
      continue;
    }
    const monthNum = monthMap[match[1].toLowerCase()];
    if (!monthNum) {
      skipped.push({ sheet: sheetName, reason: 'unrecognized month name' });
      continue;
    }
    const month = `${match[2]}-${monthNum}`;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      skipped.push({ sheet: sheetName, reason: 'empty or missing worksheet' });
      continue;
    }
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

    const headerIndex = rows.findIndex(row => row && row.some(v => /my salary/i.test(String(v || ''))) && row.some(v => /chandu salary/i.test(String(v || ''))));
    if (headerIndex < 0) {
      skipped.push({ sheet: sheetName, reason: 'salary headers (My salary / Chandu Salary) not found' });
      continue;
    }

    const headers = rows[headerIndex].map(v => String(v || '').trim().toLowerCase());
    const youCol = headers.findIndex(v => v === 'my salary');
    const chanduCol = headers.findIndex(v => v === 'chandu salary');

    let salaryFound = false;

    for (let i = headerIndex + 1; i < rows.length; i++) {
      const row = rows[i] || [];
      let description = String(row[0] ?? '').replace(/\s+/g, ' ').trim();
      if (!description) continue;

      if (/^(remaining money|total|opening balance|closing balance|total salary|total savings|total expenses)$/i.test(description)) {
        skipped.push({ sheet: sheetName, month, row: i + 1, description, reason: 'summary row excluded' });
        continue;
      }

      for (const [person, col] of [['You', youCol], ['Chandu', chanduCol]]) {
        if (col < 0) continue;
        const cellRef = XLSX.utils.encode_cell({ c: col, r: i });
        const cell = sheet[cellRef];
        if (!cell) continue;

        let rawVal = cell.v;
        if (rawVal === null || rawVal === undefined) continue;

        let val = null;
        if (typeof rawVal === 'number') {
          val = rawVal;
        } else if (typeof rawVal === 'string') {
          const cleaned = rawVal.replace(/[₹$€£,\s]/g, '');
          const parsedNum = Number(cleaned);
          if (!isNaN(parsedNum) && cleaned !== '') val = parsedNum;
        }

        if (val === null || !Number.isFinite(val) || val === 0) continue;

        const isSalary = /^salary$/i.test(description);
        if (isSalary) {
          if (val > 0) {
            result.push({
              month,
              person,
              type: 'income',
              description: 'Salary',
              category: 'Other',
              amount: Math.round(val),
              note: SALARY_IMPORT_NOTE
            });
            salaryFound = true;
          } else {
            skipped.push({ sheet: sheetName, month, person, row: i + 1, description, amount: val, reason: 'negative salary value skipped' });
          }
        } else {
          if (val < 0) {
            const amount = Math.round(Math.abs(val));
            let category = 'Other';
            if (/rent/i.test(description)) category = 'Rent';
            else if (/groceries/i.test(description)) category = 'Groceries';
            else if (/utilities|electricity|water|wifi/i.test(description)) category = 'Utilities';
            else if (/travel|flight|train|cab/i.test(description)) category = 'Travel';
            else if (/medical|hospital|pharmacy|doctor/i.test(description)) category = 'Medical';
            else if (/shopping|amazon|flipkart/i.test(description)) category = 'Shopping';
            else if (/investment|mutual fund|stocks|rd|pf|gold|apy|kite/i.test(description)) category = 'Investments';

            result.push({
              month,
              person,
              type: 'expenses',
              description,
              category,
              amount,
              note: SALARY_IMPORT_NOTE
            });
          } else if (val > 0) {
            if (/kite|broker/i.test(description)) {
              result.push({
                month,
                person,
                type: 'brokerFunds',
                description,
                account: description,
                amount: Math.round(val),
                note: SALARY_IMPORT_NOTE
              });
            } else {
              skipped.push({ sheet: sheetName, month, person, row: i + 1, description, amount: val, reason: 'positive non-salary value skipped' });
            }
          }
        }
      }
    }

    if (!salaryFound) {
      skipped.push({ sheet: sheetName, month, reason: 'no positive salary entries found' });
    }
  }

  return { rows: result, skipped };
}

export function maskDatabaseUrl(urlStr) {
  if (!urlStr) return '(not set)';
  try {
    const parsed = new URL(urlStr);
    if (parsed.password) parsed.password = '****';
    return parsed.toString();
  } catch {
    return '(invalid url)';
  }
}

export function mergeImportRows(existingData, importedRows) {
  const data = JSON.parse(JSON.stringify(existingData || {}));
  data.version = 1;
  data.people = Array.isArray(data.people) ? data.people : ['You', 'Chandu'];
  if (!data.people.includes('You')) data.people.push('You');
  if (!data.people.includes('Chandu')) data.people.push('Chandu');
  data.categories = Array.isArray(data.categories) && data.categories.length ? data.categories : ['Rent', 'Groceries', 'Utilities', 'Travel', 'Medical', 'Shopping', 'Investments', 'Other'];
  data.accounts = Array.isArray(data.accounts) ? data.accounts : [];
  data.months = data.months && typeof data.months === 'object' ? data.months : {};
  data.imports = Array.isArray(data.imports) ? data.imports : [];

  let addedCount = 0;
  let duplicateCount = 0;
  let brokerFundCount = 0;
  const seenInImport = new Set();

  for (const row of importedRows) {
    const month = row.month;
    const person = row.person;
    const type = row.type;

    data.months[month] ||= { people: {}, bankBalances: [], brokerFunds: [] };
    const m = data.months[month];

    if (type === 'brokerFunds') {
      m.brokerFunds ||= [];
      const importKey = [month, person, 'brokerFunds', row.description, row.amount, row.note].join('|');
      const isDuplicate = m.brokerFunds.some(b =>
        (b.person === person || b.person === row.person) &&
        (b.account === row.description || b.description === row.description) &&
        Number(b.amount) === row.amount &&
        (b.note === row.note || String(b.note || '').includes('Expense Tracker'))
      );

      if (isDuplicate || seenInImport.has(importKey)) {
        duplicateCount++;
        continue;
      }

      seenInImport.add(importKey);
      m.brokerFunds.push({
        person: row.person,
        account: row.account || row.description,
        description: row.description,
        amount: row.amount,
        note: row.note
      });
      addedCount++;
      brokerFundCount++;
      continue;
    }

    m.people ||= {};
    m.people[person] ||= { income: [], expenses: [] };
    const personLedger = m.people[person];
    personLedger[type] ||= [];

    const existingEntries = personLedger[type];
    const isDuplicate = existingEntries.some(e =>
      e.description === row.description &&
      Number(e.amount) === row.amount &&
      (e.note === row.note || String(e.note || '').includes('Expense Tracker'))
    );

    const importKey = [month, person, type, row.description, row.amount, row.note].join('|');

    if (isDuplicate || seenInImport.has(importKey)) {
      duplicateCount++;
      continue;
    }

    seenInImport.add(importKey);
    personLedger[type].push({
      description: row.description,
      category: row.category || 'Other',
      amount: row.amount,
      note: row.note
    });
    addedCount++;
  }

  return { data, addedCount, duplicateCount, brokerFundCount };
}

async function run() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run') || args.includes('--preview');
  const doBackup = args.includes('--backup');

  let filePath = 'sheets/Expense Tracker - 2026.xlsx';
  const fileArgIdx = args.indexOf('--file');
  if (fileArgIdx >= 0 && args[fileArgIdx + 1]) {
    filePath = args[fileArgIdx + 1];
  }

  console.log('--- Expense Tracker Historical Data Import ---');
  console.log(`Workbook path: ${filePath}`);
  console.log(`Mode: ${isDryRun ? 'DRY-RUN / PREVIEW (no database writes)' : 'EXECUTE IMPORT'}`);
  console.log(`Target DB URL: ${maskDatabaseUrl(process.env.EXPENSE_TRACKER_DATABASE_URL)}`);

  let fileBuffer;
  try {
    fileBuffer = await readFile(path.resolve(process.cwd(), filePath));
  } catch (err) {
    console.error(`Error reading workbook file at ${filePath}: ${err.message}`);
    process.exit(1);
  }

  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellFormulas: true, cellDates: true });
  const parsed = parseSalaryWorkbook(workbook);

  const monthsSet = new Set(parsed.rows.map(r => r.month));
  const incomeRows = parsed.rows.filter(r => r.type === 'income');
  const expenseRows = parsed.rows.filter(r => r.type === 'expenses');
  const brokerRows = parsed.rows.filter(r => r.type === 'brokerFunds');
  const totalIncome = incomeRows.reduce((sum, r) => sum + r.amount, 0);
  const totalExpenses = expenseRows.reduce((sum, r) => sum + r.amount, 0);
  const totalBroker = brokerRows.reduce((sum, r) => sum + r.amount, 0);

  console.log('\n--- Workbook Inspection Summary ---');
  console.log(`Recognized months (${monthsSet.size}): ${Array.from(monthsSet).sort().join(', ')}`);
  console.log(`Income entries: ${incomeRows.length} (Total: ₹${totalIncome.toLocaleString('en-IN')})`);
  console.log(`Expense entries: ${expenseRows.length} (Total: ₹${totalExpenses.toLocaleString('en-IN')})`);
  console.log(`Broker fund entries: ${brokerRows.length} (Total: ₹${totalBroker.toLocaleString('en-IN')})`);
  console.log(`Skipped items / exclusions: ${parsed.skipped.length}`);

  if (parsed.skipped.length > 0) {
    console.log('\n--- Skipped Items Details ---');
    for (const item of parsed.skipped) {
      if (item.reason === 'summary row excluded') {
        console.log(`  [SUMMARY EXCLUDED] Sheet: ${item.sheet}, Month: ${item.month}, Row: ${item.row}, Desc: "${item.description}"`);
      } else if (item.reason === 'positive non-salary value skipped') {
        console.log(`  [NON-SALARY EXCLUDED] Sheet: ${item.sheet}, Person: ${item.person}, Row: ${item.row}, Desc: "${item.description}", Amount: ₹${item.amount}`);
      } else {
        console.log(`  [SKIPPED] Sheet: ${item.sheet}, Reason: ${item.reason}`);
      }
    }
  }

  if (isDryRun) {
    console.log('\n[DRY-RUN] Reading current database workspace for collision preview...');
    try {
      const currentWorkspace = await readExpenseData();
      const { addedCount, duplicateCount, brokerFundCount } = mergeImportRows(currentWorkspace, parsed.rows);
      console.log(`[DRY-RUN PREVIEW] Would add ${addedCount} new entries (${brokerFundCount} broker fund entries, ${duplicateCount} duplicate entries skipped).`);
      console.log('[DRY-RUN COMPLETE] No database writes were made.');
    } catch (err) {
      console.log(`[DRY-RUN WARNING] Could not read target database: ${err.message}`);
      console.log('[DRY-RUN NOTE] Dry-run completed. Ensure EXPENSE_TRACKER_DATABASE_URL is set to run full database merge preview.');
    } finally {
      await closeExpenseTrackerPool();
    }
    return;
  }

  // Live import mode
  console.log('\nConnecting to Expense Tracker database...');
  let currentWorkspace;
  try {
    currentWorkspace = await readExpenseData();
  } catch (err) {
    console.error(`Database connection error: ${err.message}`);
    await closeExpenseTrackerPool();
    process.exit(1);
  }

  if (doBackup) {
    const backupDir = path.resolve(process.cwd(), 'data', 'private');
    await mkdir(backupDir, { recursive: true });
    const backupFile = path.join(backupDir, `expense-tracker-backup-${Date.now()}.json`);
    await writeFile(backupFile, JSON.stringify(currentWorkspace, null, 2), 'utf8');
    console.log(`[BACKUP CREATED] Saved existing workspace backup to: ${backupFile}`);
  }

  const { data: updatedWorkspace, addedCount, duplicateCount } = mergeImportRows(currentWorkspace, parsed.rows);

  console.log(`\nImporting ${addedCount} new records (${duplicateCount} duplicates skipped)...`);
  try {
    await writeExpenseData(updatedWorkspace);
    console.log('[SUCCESS] Historical data successfully imported and synced to PostgreSQL workspace.');
    console.log(`Final totals across workspace: ${Object.keys(updatedWorkspace.months).length} months recorded.`);
  } catch (err) {
    console.error(`[IMPORT FAILED] Transaction rolled back: ${err.message}`);
    process.exit(1);
  } finally {
    await closeExpenseTrackerPool();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '');
if (isMain) {
  run().catch(err => {
    console.error('Import script error:', err.message);
    process.exit(1);
  });
}
