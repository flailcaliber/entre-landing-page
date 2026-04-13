#!/usr/bin/env node
/**
 * Entre Waitlist — Local Email Import Script
 *
 * Reads emails from an Excel (.xlsx/.xls) or CSV file and inserts them
 * into the Supabase waitlist table, skipping duplicates.
 *
 * Usage:
 *   node scripts/import_emails.js <path-to-file> [--dry-run]
 *
 * Setup (run once from the landing/ directory):
 *   npm install
 *
 * Required env vars (create a .env file in landing/ or set in shell):
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
 *
 * The script auto-detects the email column by looking for:
 *   - A header row containing "email" (case-insensitive)
 *   - Falls back to the first column if no header match is found
 */

require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ───────────────────────────────────────────────────

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_SIZE        = 50;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('\nMissing env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n');
  console.error('Create a .env file in the landing/ directory:\n');
  console.error('  SUPABASE_URL=https://yourproject.supabase.co');
  console.error('  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key\n');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function extractEmails(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let workbook;

  if (ext === '.csv') {
    const content = fs.readFileSync(filePath, 'utf8');
    workbook = XLSX.read(content, { type: 'string' });
  } else {
    workbook = XLSX.readFile(filePath);
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  if (rows.length === 0) {
    console.error('File appears to be empty.');
    process.exit(1);
  }

  // Try to find email and phone column indices from header row
  const header = rows[0].map(h => String(h).toLowerCase().trim());
  let emailColIdx = header.findIndex(h => h.includes('email'));
  let phoneColIdx = header.findIndex(h => h.includes('phone'));

  if (emailColIdx === -1) {
    console.log('No "email" header found — using first column.');
    emailColIdx = 0;
  } else {
    console.log(`Found email column: "${rows[0][emailColIdx]}" (col ${emailColIdx + 1})`);
  }

  if (phoneColIdx !== -1) {
    console.log(`Found phone column: "${rows[0][phoneColIdx]}" (col ${phoneColIdx + 1})`);
  }

  // Determine if first row is a header or data
  const startRow = isValidEmail(String(rows[0][emailColIdx])) ? 0 : 1;
  const records  = [];
  const invalid  = [];

  for (let i = startRow; i < rows.length; i++) {
    const raw = String(rows[i][emailColIdx] || '').trim().toLowerCase();
    if (!raw) continue;
    if (isValidEmail(raw)) {
      const phone = phoneColIdx !== -1 ? String(rows[i][phoneColIdx] || '').trim() : null;
      records.push({ email: raw, phone: phone || null });
    } else {
      invalid.push(raw);
    }
  }

  return { records, invalid };
}

async function insertBatch(supabase, batch, dryRun) {
  if (dryRun) {
    console.log(`  [dry-run] Would insert ${batch.length} records`);
    return { inserted: batch.length, duplicates: 0 };
  }

  const records = batch.map(({ email, phone }) => ({
    email,
    phone: phone || null,
    referral_code: generateCode(),
    source: 'imported',
  }));

  const { error } = await supabase.from('waitlist').upsert(records, {
    onConflict: 'email',
    ignoreDuplicates: true,
  });

  if (error) throw error;
  return { inserted: batch.length };
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const filePath = args.find(a => !a.startsWith('--'));

  if (!filePath) {
    console.log('\nUsage: node scripts/import_emails.js <path-to-file> [--dry-run]\n');
    console.log('  Supported formats: .xlsx, .xls, .csv');
    console.log('  --dry-run  Parse and validate without inserting\n');
    process.exit(0);
  }

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`File not found: ${absPath}`);
    process.exit(1);
  }

  console.log(`\nEntre Waitlist Import${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('─'.repeat(40));
  console.log(`File: ${absPath}`);

  const { records, invalid } = extractEmails(absPath);
  const seen   = new Set();
  const unique = records.filter(r => { if (seen.has(r.email)) return false; seen.add(r.email); return true; });
  const hasPhone = unique.some(r => r.phone);

  console.log(`\nParsed:   ${records.length} rows`);
  console.log(`Valid:    ${unique.length} unique emails`);
  if (hasPhone) console.log(`Phone:    ${unique.filter(r => r.phone).length} with phone numbers`);
  if (invalid.length > 0) {
    console.log(`Invalid:  ${invalid.length} rows skipped`);
    invalid.slice(0, 5).forEach(e => console.log(`  - ${e}`));
    if (invalid.length > 5) console.log(`  ... and ${invalid.length - 5} more`);
  }

  if (unique.length === 0) {
    console.log('\nNothing to import.');
    process.exit(0);
  }

  if (!dryRun) {
    const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    await new Promise(resolve => {
      readline.question(`\nInsert ${unique.length} records into Supabase? (y/N) `, ans => {
        readline.close();
        if (ans.toLowerCase() !== 'y') {
          console.log('Aborted.');
          process.exit(0);
        }
        resolve();
      });
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  let totalInserted = 0;
  const batches = [];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    batches.push(unique.slice(i, i + BATCH_SIZE));  // each element is { email, phone }
  }

  console.log(`\nInserting in ${batches.length} batch(es)...`);

  for (let i = 0; i < batches.length; i++) {
    process.stdout.write(`  Batch ${i + 1}/${batches.length}... `);
    const { inserted } = await insertBatch(supabase, batches[i], dryRun);
    totalInserted += inserted;
    console.log(`done (${inserted})`);
  }

  console.log('\n─'.repeat(40));
  console.log(`Import complete.`);
  console.log(`Inserted: ${totalInserted} records (duplicates silently skipped)`);
  if (dryRun) console.log('(DRY RUN — nothing was actually written)');
  console.log('');
}

main().catch(err => {
  console.error('\nFatal error:', err.message || err);
  process.exit(1);
});
