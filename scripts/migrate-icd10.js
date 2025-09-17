#!/usr/bin/env node

/**
 * ICD-10 migration script
 *
 * Reads rows from the existing SQLite database (icd10.db)
 * and inserts/updates documents in the Appwrite `icd10_codes` collection
 * using the new schema.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import dotenv from 'dotenv';

import { AppwriteClient } from '../awm-package/lib/appwrite.js';

const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), '../icd10.db');
const BATCH_SIZE = parseInt(process.env.ICD10_MIGRATION_BATCH || '500', 10);

function loadEnv() {
  const envFile = path.resolve(process.cwd(), '../.env');
  if (os.type() !== 'Windows_NT' && !process.env.APPWRITE_PROJECT_ID && fsExists(envFile)) {
    dotenv.config({ path: envFile });
  }
}

function fsExists(targetPath) {
  try {
    fs.statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function normalizeCode(code) {
  return code.replace(/[^a-zA-Z0-9_-]/g, '-');
}

async function fetchRows(sqlitePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
   const sqlite = spawn('sqlite3', [
     sqlitePath,
     "-cmd",
     ".mode list",
     "-cmd",
     ".separator |",
     "SELECT code, description, category, subcategory, parent_code, IFNULL(is_dsm5,0), dsm5_description, created_at FROM icd10_codes ORDER BY code;"
   ]);

    sqlite.on('error', error => {
      reject(new Error(`Failed to launch sqlite3: ${error.message}`));
    });

    let stdout = '';
    let stderr = '';

    sqlite.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });

    sqlite.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });

    sqlite.on('close', code => {
      if (code !== 0) {
        return reject(new Error(`sqlite3 exited with code ${code}: ${stderr}`));
      }

      const lines = stdout.split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < 6) continue;
        const [
          codeValue,
          description,
          category,
          subcategory,
          parentCode,
          isDsm5Raw,
          dsm5Description,
          createdAtRaw
        ] = parts;

        rows.push({
          code: codeValue,
          description,
          category: category || null,
          subcategory: subcategory || null,
          parent_code: parentCode || null,
          is_dsm5: isDsm5Raw === '1',
          dsm5_description: dsm5Description || null,
          created_at: createdAtRaw || null
        });
      }

      resolve(rows);
    });
  });
}

async function upsert(client, databaseId, collectionId, row) {
  const documentId = normalizeCode(row.code);
 const payload = {
   code: row.code,
   description: row.description,
   category: row.category,
   subcategory: row.subcategory,
   parent_code: row.parent_code,
   is_dsm5: row.is_dsm5,
   dsm5_description: row.dsm5_description,
    dsm5_category: null,
    dsm5_subcategory: null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString(),
    last_verified: new Date().toISOString(),
    version: 1
  };

  try {
    await client.createDocument(databaseId, collectionId, documentId, payload);
    return 'created';
  } catch (error) {
    if (error.status === 409) {
      await client.updateDocument(databaseId, collectionId, documentId, payload);
      return 'updated';
    }
    throw error;
  }
}

async function main() {
  loadEnv();

  const sqlitePath = process.env.SQLITE_DB_PATH || DEFAULT_SQLITE_PATH;
  const appwriteEndpoint = requireEnv('APPWRITE_ENDPOINT');
  const appwriteProject = requireEnv('APPWRITE_PROJECT_ID');
  const appwriteKey = requireEnv('APPWRITE_API_KEY');
  const databaseId = requireEnv('APPWRITE_DATABASE_ID');
  const collectionId = 'icd10-codes';

  console.log(`Loading ICD-10 rows from ${sqlitePath}...`);
  const rows = await fetchRows(sqlitePath);
  console.log(`Found ${rows.length} rows`);

  const client = new AppwriteClient({
    endpoint: appwriteEndpoint,
    projectId: appwriteProject,
    apiKey: appwriteKey
  });

  let created = 0;
  let updated = 0;
  let processed = 0;

  for (const row of rows) {
    const result = await upsert(client, databaseId, collectionId, row);
    processed += 1;
    if (result === 'created') created += 1;
    if (result === 'updated') updated += 1;

    if (processed % BATCH_SIZE === 0) {
      console.log(`Processed ${processed}/${rows.length} rows...`);
    }
  }

  console.log('Migration complete');
  console.log(`Created: ${created}`);
  console.log(`Updated: ${updated}`);
}

main().catch(error => {
  console.error('Migration failed:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
