#!/usr/bin/env node

/**
 * AWM - Appwrite Migration Tool (Improved)
 *
 * Features:
 * - Tracks migration state in SQLite database
 * - Only creates/modifies what doesn't exist
 * - Supports two-phase migrations (collections then relationships)
 * - Proper rollback support
 * - Dry-run mode
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import readline from 'readline';
import dotenv from 'dotenv';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
};

class AWMImproved {
  constructor() {
    this.root = process.cwd();
    this.config = this.loadConfig();
    
    // Configuration - ENV vars take precedence over config file
    this.schemaFile = path.resolve(this.root, process.env.AWM_SCHEMA || this.config.schemaPath || 'appwrite.schema');
    this.migrationsDir = path.resolve(this.root, process.env.AWM_MIGRATIONS_DIR || this.config.migrationsDir || 'migrations');
    this.stateDbFile = path.join(this.migrationsDir, process.env.AWM_STATE_DB || this.config.stateDb || '.awm-state.db');
    
    // Appwrite connection - ENV first, config second, sensible defaults last
    this.appwriteProject = process.env.APPWRITE_PROJECT_ID || this.config.projectId;
    this.appwriteEndpoint = process.env.APPWRITE_ENDPOINT || this.config.endpoint || 'http://localhost/v1';
    this.appwriteKey = process.env.APPWRITE_API_KEY || this.config.apiKey;
    this.databaseId = process.env.APPWRITE_DATABASE_ID || this.config.databaseId || this.extractDatabaseId();
    
    // Flags
    this.dryRun = false;
    this.debug = process.env.AWM_DEBUG === 'true' || this.config.debug;
    
    // Initialize state database
    this.initStateDb();
    
    // CLI
    const argv = process.argv.slice(2);
    this.command = argv[0];
    this.args = argv.slice(1);
    
    // Parse flags
    for (let i = 0; i < this.args.length; i++) {
      const a = this.args[i];
      if (a === '--dry-run') this.dryRun = true;
      if (a === '--yes') this.nonInteractive = true;
      if (a === '--force') this.force = true;
    }
  }

  loadConfig() {
    // Try multiple config locations
    const configLocations = [
      path.join(this.root, 'awm.config.json'),
      path.join(this.root, '.awm.json'),
      path.join(this.root, 'config', 'awm.json'),
      path.join(this.root, '.config', 'awm.json')
    ];
    
    for (const configFile of configLocations) {
      if (fs.existsSync(configFile)) {
        if (this.debug) console.log(`${colors.gray}Loading config from: ${configFile}${colors.reset}`);
        return JSON.parse(fs.readFileSync(configFile, 'utf8'));
      }
    }
    
    // Check for .env file
    const envFile = path.join(this.root, '.env');
    if (fs.existsSync(envFile)) {
      dotenv.config({ path: envFile });
    }
    
    return {};
  }
  
  extractDatabaseId() {
    // Try to extract database ID from schema if not provided
    if (fs.existsSync(this.schemaFile)) {
      const content = fs.readFileSync(this.schemaFile, 'utf8');
      const match = content.match(/database\s*{\s*[^}]*id\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
    return 'database';
  }

  initStateDb() {
    if (!fs.existsSync(this.migrationsDir)) {
      fs.mkdirSync(this.migrationsDir, { recursive: true });
    }
    
    this.db = new Database(this.stateDbFile);
    
    // Create tables if they don't exist
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        phase INTEGER DEFAULT 1,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        checksum TEXT,
        status TEXT DEFAULT 'pending',
        error_message TEXT
      );
      
      CREATE TABLE IF NOT EXISTS collections (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        checksum TEXT
      );
      
      CREATE TABLE IF NOT EXISTS attributes (
        id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL,
        key TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER,
        required BOOLEAN DEFAULT 0,
        is_array BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(collection_id, key),
        FOREIGN KEY (collection_id) REFERENCES collections(id)
      );
      
      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        from_collection TEXT NOT NULL,
        to_collection TEXT NOT NULL,
        type TEXT NOT NULL,
        attribute_name TEXT NOT NULL,
        two_way_key TEXT,
        on_delete TEXT DEFAULT 'restrict',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(from_collection, attribute_name)
      );
      
      CREATE TABLE IF NOT EXISTS indexes (
        id TEXT PRIMARY KEY,
        collection_id TEXT NOT NULL,
        key TEXT NOT NULL,
        type TEXT NOT NULL,
        attributes TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(collection_id, key),
        FOREIGN KEY (collection_id) REFERENCES collections(id)
      );
    `);
  }

  async run() {
    try {
      switch (this.command) {
        case 'init':
          await this.init();
          break;
        case 'plan':
          await this.plan();
          break;
        case 'apply':
          await this.apply();
          break;
        case 'status':
          await this.status();
          break;
        case 'rollback':
          await this.rollback(this.firstPositionalArg());
          break;
        case 'reset':
          await this.reset();
          break;
        case 'sync':
          await this.sync();
          break;
        case 'relationships':
          await this.applyRelationships();
          break;
        case 'generate-types':
          await this.generateTypes(this.firstPositionalArg() || './types/appwrite.types.ts');
          break;
        case 'generate-zod':
          await this.generateZod(this.firstPositionalArg() || './schemas/appwrite.schemas.ts');
          break;
        case 'generate': {
          const [typesPath, zodPath] = this.positionalArgs(2);
          await this.generateArtifacts(typesPath || './types/appwrite.types.ts', zodPath || './schemas/appwrite.schemas.ts');
          break;
        }
        case 'help':
        case undefined:
          this.showHelp();
          break;
        default:
          console.error(`${colors.red}Unknown command: ${this.command}${colors.reset}`);
          this.showHelp();
          process.exit(1);
      }
    } catch (error) {
      console.error(`${colors.red}✗ Error: ${error.message}${colors.reset}`);
      if (this.config.debug) {
        console.error(error.stack);
      }
      process.exit(1);
    } finally {
      this.db?.close();
    }
  }

  positionalArgs(limit = Infinity) {
    const values = [];
    for (const arg of this.args) {
      if (arg?.startsWith('--')) continue;
      values.push(arg);
      if (values.length >= limit) break;
    }
    return values;
  }

  firstPositionalArg() {
    return this.positionalArgs(1)[0];
  }

  async loadGenerators() {
    if (!this.generators) {
      const [{ default: TypeGenerator }, { default: ZodGenerator }] = await Promise.all([
        import('./type-generator.js'),
        import('./zod-generator.js')
      ]);
      this.generators = { TypeGenerator, ZodGenerator };
    }
    return this.generators;
  }

  async generateTypes(outputPath) {
    const { TypeGenerator } = await this.loadGenerators();
    const generator = new TypeGenerator(this.schemaFile);
    await generator.generate(outputPath);
  }

  async generateZod(outputPath) {
    const { ZodGenerator } = await this.loadGenerators();
    const generator = new ZodGenerator(this.schemaFile);
    await generator.generate(outputPath);
  }

  async generateArtifacts(typesPath, zodPath) {
    console.log('\n🚀 Generating TypeScript types and Zod schemas...\n');
    await this.generateTypes(typesPath);
    await this.generateZod(zodPath);
    console.log('\n✨ All generators completed successfully!');
  }

  async init() {
    console.log(`${colors.cyan}Initializing AWM in ${this.root}${colors.reset}\n`);

    const { default: initProject } = await import('./init.js');
    await initProject();

    console.log(`\n${colors.green}✓ AWM initialized successfully!${colors.reset}`);
  }

  async plan() {
    console.log(`${colors.cyan}Planning migration from schema...${colors.reset}\n`);
    
    // Show config being used
    if (this.debug || !this.appwriteProject) {
      console.log(`${colors.gray}Config:${colors.reset}`);
      console.log(`  Endpoint: ${this.appwriteEndpoint}`);
      console.log(`  Project: ${this.appwriteProject || colors.red + 'NOT SET' + colors.reset}`);
      console.log(`  Database: ${this.databaseId}`);
      console.log(`  Schema: ${this.schemaFile}`);
      console.log();
      
      if (!this.appwriteProject) {
        console.error(`${colors.red}✗ APPWRITE_PROJECT_ID not set${colors.reset}`);
        console.log(`Set via: export APPWRITE_PROJECT_ID=your-project-id`);
        process.exit(1);
      }
    }
    
    const schema = this.parseSchema(fs.readFileSync(this.schemaFile, 'utf8'));
    const changes = await this.calculateChanges(schema);
    
    if (changes.collections.length === 0 && 
        changes.attributes.length === 0 && 
        changes.indexes.length === 0) {
      console.log(`${colors.green}✓${colors.reset} Schema is up to date. No changes needed.`);
      return;
    }
    
    console.log(`${colors.yellow}Planned changes:${colors.reset}\n`);
    
    if (changes.collections.length > 0) {
      console.log(`${colors.bright}Collections to create:${colors.reset}`);
      for (const coll of changes.collections) {
        console.log(`  ${colors.green}+${colors.reset} ${coll.name} (${coll.id})`);
      }
      console.log();
    }
    
    if (changes.attributes.length > 0) {
      console.log(`${colors.bright}Attributes to create:${colors.reset}`);
      for (const attr of changes.attributes) {
        console.log(`  ${colors.green}+${colors.reset} ${attr.collection_id}.${attr.key} (${attr.type})`);
      }
      console.log();
    }
    
    if (changes.indexes.length > 0) {
      console.log(`${colors.bright}Indexes to create:${colors.reset}`);
      for (const idx of changes.indexes) {
        console.log(`  ${colors.green}+${colors.reset} ${idx.collection_id}.${idx.key}`);
      }
      console.log();
    }
    
    if (this.dryRun) {
      console.log(`${colors.gray}Dry run - no changes made${colors.reset}`);
      return;
    }
    
    // Save planned changes
    const migrationId = `migration_${Date.now()}`;
    const stmt = this.db.prepare(`
      INSERT INTO migrations (id, name, phase, status, checksum)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run(
      migrationId,
      'Schema sync',
      1,
      'planned',
      this.generateChecksum(changes)
    );
    
    fs.writeFileSync(
      path.join(this.migrationsDir, `${migrationId}.json`),
      JSON.stringify(changes, null, 2)
    );
    
    console.log(`${colors.green}✓${colors.reset} Migration planned: ${migrationId}`);
    console.log(`Run ${colors.cyan}awm apply${colors.reset} to execute the migration`);
  }

  async apply() {
    console.log(`${colors.cyan}Applying pending migrations...${colors.reset}\n`);
    
    const pending = this.db.prepare(`
      SELECT * FROM migrations 
      WHERE status = 'planned' 
      ORDER BY id
    `).all();
    
    if (pending.length === 0) {
      console.log(`${colors.green}✓${colors.reset} No pending migrations`);
      return;
    }
    
    for (const migration of pending) {
      console.log(`${colors.cyan}Applying ${migration.id}...${colors.reset}`);
      
      const changesFile = path.join(this.migrationsDir, `${migration.id}.json`);
      if (!fs.existsSync(changesFile)) {
        console.error(`${colors.red}✗ Migration file not found${colors.reset}`);
        continue;
      }
      
      const changes = JSON.parse(fs.readFileSync(changesFile, 'utf8'));
      
      try {
        await this.applyChanges(changes);
        
        this.db.prepare(`
          UPDATE migrations 
          SET status = 'applied', applied_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(migration.id);
        
        console.log(`${colors.green}✓${colors.reset} Applied successfully`);
      } catch (error) {
        this.db.prepare(`
          UPDATE migrations 
          SET status = 'failed', error_message = ?
          WHERE id = ?
        `).run(error.message, migration.id);
        
        console.error(`${colors.red}✗ Failed: ${error.message}${colors.reset}`);
        if (!this.force) break;
      }
    }
  }

  async rollback(requestedId) {
    console.log(`${colors.cyan}Rolling back migration state...${colors.reset}\n`);

    const migration = requestedId
      ? this.db.prepare('SELECT * FROM migrations WHERE id = ?').get(requestedId)
      : this.db.prepare(`
          SELECT * FROM migrations
          WHERE status = 'applied'
          ORDER BY applied_at DESC
          LIMIT 1
        `).get();

    if (!migration) {
      console.log(`${colors.yellow}No applied migrations found to roll back.${colors.reset}`);
      return;
    }

    if (migration.status !== 'applied') {
      console.log(`${colors.yellow}Migration ${migration.id} is not applied (current status: ${migration.status}). Nothing to roll back.${colors.reset}`);
      return;
    }

    const changesFile = path.join(this.migrationsDir, `${migration.id}.json`);
    if (!fs.existsSync(changesFile)) {
      console.error(`${colors.red}✗ Unable to rollback: migration plan file missing (${changesFile}).${colors.reset}`);
      return;
    }

    const changes = JSON.parse(fs.readFileSync(changesFile, 'utf8'));
    const dbId = this.databaseId;

    const stats = { indexes: 0, attributes: 0, collections: 0 };

    const deleteIndex = idx => {
      const label = `${idx.collection_id}.${idx.key}`;
      if (this.dryRun) {
        stats.indexes++;
        console.log(`  [dry-run] Would delete index: ${label}`);
        return;
      }

      try {
        execSync(`appwrite databases delete-index \\
          --database-id ${dbId} \\
          --collection-id "${idx.collection_id}" \\
          --key "${idx.key}"`, { stdio: 'pipe' });
        stats.indexes++;
        console.log(`  ${colors.green}✓${colors.reset} Deleted index: ${label}`);
      } catch (error) {
        if (this.isIgnorableCliError(error)) {
          console.log(`  ${colors.gray}○${colors.reset} Index already removed: ${label}`);
        } else if (this.force) {
          console.warn(`  ${colors.yellow}⚠${colors.reset} Failed to delete index ${label}: ${error.message}`);
        } else {
          throw error;
        }
      } finally {
        this.db.prepare('DELETE FROM indexes WHERE id = ?').run(`${idx.collection_id}_${idx.key}`);
      }
    };

    const deleteAttribute = attr => {
      const label = `${attr.collection_id}.${attr.key}`;
      if (this.dryRun) {
        stats.attributes++;
        console.log(`  [dry-run] Would delete attribute: ${label}`);
        return;
      }

      try {
        execSync(`appwrite databases delete-attribute \\
          --database-id ${dbId} \\
          --collection-id "${attr.collection_id}" \\
          --key "${attr.key}"`, { stdio: 'pipe' });
        stats.attributes++;
        console.log(`  ${colors.green}✓${colors.reset} Deleted attribute: ${label}`);
      } catch (error) {
        if (this.isIgnorableCliError(error)) {
          console.log(`  ${colors.gray}○${colors.reset} Attribute already removed: ${label}`);
        } else if (this.force) {
          console.warn(`  ${colors.yellow}⚠${colors.reset} Failed to delete attribute ${label}: ${error.message}`);
        } else {
          throw error;
        }
      } finally {
        this.db.prepare('DELETE FROM attributes WHERE id = ?').run(`${attr.collection_id}_${attr.key}`);
      }
    };

    const deleteCollection = coll => {
      if (this.dryRun) {
        stats.collections++;
        console.log(`  [dry-run] Would delete collection: ${coll.id}`);
        return;
      }

      try {
        execSync(`appwrite databases delete-collection \\
          --database-id ${dbId} \\
          --collection-id "${coll.id}"`, { stdio: 'pipe' });
        stats.collections++;
        console.log(`  ${colors.green}✓${colors.reset} Deleted collection: ${coll.id}`);
      } catch (error) {
        if (this.isIgnorableCliError(error)) {
          console.log(`  ${colors.gray}○${colors.reset} Collection already removed: ${coll.id}`);
        } else if (this.force) {
          console.warn(`  ${colors.yellow}⚠${colors.reset} Failed to delete collection ${coll.id}: ${error.message}`);
        } else {
          throw error;
        }
      } finally {
        this.db.prepare('DELETE FROM collections WHERE id = ?').run(coll.id);
      }
    };

    try {
      // Process indexes first to avoid attribute dependencies
      [...(changes.indexes || [])].reverse().forEach(deleteIndex);
      // Then attributes
      [...(changes.attributes || [])].reverse().forEach(deleteAttribute);
      // Finally collections
      [...(changes.collections || [])].reverse().forEach(deleteCollection);

      if (!this.dryRun) {
        this.db.prepare(`
          UPDATE migrations
          SET status = 'rolled_back', applied_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(migration.id);
      }

      console.log(`\n${colors.green}✓${colors.reset} Rollback complete for ${migration.id}`);
      console.log(`  Collections removed: ${stats.collections}`);
      console.log(`  Attributes removed:  ${stats.attributes}`);
      console.log(`  Indexes removed:     ${stats.indexes}`);
    } catch (error) {
      console.error(`${colors.red}✗ Rollback failed: ${error.message}${colors.reset}`);
      if (!this.force) throw error;
    }
  }

  async applyChanges(changes) {
    const dbId = this.databaseId;
    
    // Create collections
    for (const coll of changes.collections || []) {
      if (this.dryRun) {
        console.log(`  [dry-run] Would create collection: ${coll.name}`);
        continue;
      }
      
      try {
        execSync(`appwrite databases create-collection \
          --database-id ${dbId} \
          --collection-id "${coll.id}" \
          --name "${coll.name}" \
          --enabled true`, 
          { stdio: 'pipe' }
        );
        
        // Record in state DB
        this.db.prepare(`
          INSERT INTO collections (id, name, checksum)
          VALUES (?, ?, ?)
        `).run(coll.id, coll.name, this.generateChecksum(coll));
        
        console.log(`  ${colors.green}✓${colors.reset} Created collection: ${coll.name}`);
      } catch (error) {
        if (!error.message.includes('already exists')) {
          throw error;
        }
        console.log(`  ${colors.gray}○${colors.reset} Collection already exists: ${coll.name}`);
      }
    }
    
    // Create attributes
    for (const attr of changes.attributes || []) {
      if (this.dryRun) {
        console.log(`  [dry-run] Would create attribute: ${attr.collection_id}.${attr.key}`);
        continue;
      }
      
      try {
        const cmd = this.buildAttributeCommand(dbId, attr);
        execSync(cmd, { stdio: 'pipe' });
        
        // Record in state DB
        this.db.prepare(`
          INSERT INTO attributes (id, collection_id, key, type, size, required, is_array)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          `${attr.collection_id}_${attr.key}`,
          attr.collection_id,
          attr.key,
          attr.type,
          attr.size || null,
          attr.required ? 1 : 0,
          attr.array ? 1 : 0
        );
        
        console.log(`  ${colors.green}✓${colors.reset} Created attribute: ${attr.collection_id}.${attr.key}`);
      } catch (error) {
        if (!error.message.includes('already exists')) {
          throw error;
        }
        console.log(`  ${colors.gray}○${colors.reset} Attribute already exists: ${attr.key}`);
      }
    }
    
    // Create indexes
    for (const idx of changes.indexes || []) {
      if (this.dryRun) {
        console.log(`  [dry-run] Would create index: ${idx.collection_id}.${idx.key}`);
        continue;
      }
      
      try {
        const attrs = (idx.attributes || []).join(',');
        const orders = (idx.orders || []).filter(Boolean).map(order => order.toUpperCase());
        const orderFlag = orders.length ? ` \\
          --orders "${orders.join(',')}"` : '';

        execSync(`appwrite databases create-index \
          --database-id ${dbId} \
          --collection-id "${idx.collection_id}" \
          --key "${idx.key}" \
          --type "${idx.type}" \
          --attributes "${attrs}"${orderFlag}`,
          { stdio: 'pipe' }
        );
        
        // Record in state DB
        this.db.prepare(`
          INSERT INTO indexes (id, collection_id, key, type, attributes)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          `${idx.collection_id}_${idx.key}`,
          idx.collection_id,
          idx.key,
          idx.type,
          orders.length ? `${attrs}|${orders.join(',')}` : attrs
        );
        
        console.log(`  ${colors.green}✓${colors.reset} Created index: ${idx.key}`);
      } catch (error) {
        if (!error.message.includes('already exists')) {
          throw error;
        }
        console.log(`  ${colors.gray}○${colors.reset} Index already exists: ${idx.key}`);
      }
    }
  }

  isIgnorableCliError(error) {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('not found') || message.includes('does not exist') || message.includes('404');
  }

  buildAttributeCommand(dbId, attr) {
    const base = `appwrite databases`;
    const common = `--database-id ${dbId} --collection-id "${attr.collection_id}" --key "${attr.key}"`;
    const req = attr.required ? '--required true' : '--required false';
    const arr = attr.array ? '--array true' : '--array false';
    const type = attr.type.toLowerCase();
    const defaultValue = !attr.array ? this.formatCliValue(attr.default, type) : null;

    const parts = [];

    switch (type) {
      case 'string':
        parts.push(`${base} create-string-attribute ${common} --size ${attr.size || 255}`);
        break;
      case 'integer':
      case 'int':
        parts.push(`${base} create-integer-attribute ${common}`);
        break;
      case 'float':
      case 'double':
        parts.push(`${base} create-float-attribute ${common}`);
        break;
      case 'boolean':
      case 'bool':
        parts.push(`${base} create-boolean-attribute ${common}`);
        break;
      case 'datetime':
        parts.push(`${base} create-datetime-attribute ${common}`);
        break;
      case 'email':
        parts.push(`${base} create-email-attribute ${common}`);
        break;
      case 'url':
        parts.push(`${base} create-url-attribute ${common}`);
        break;
      default:
        throw new Error(`Unknown attribute type: ${attr.type}`);
    }

    parts.push(req, arr);

    if (defaultValue !== null && defaultValue !== undefined) {
      parts.push(`--default ${defaultValue}`);
    }

    return parts.join(' ');
  }

  async applyRelationships() {
    console.log(`${colors.cyan}Applying relationships (Phase 2)...${colors.reset}\n`);
    
    const schema = this.parseSchema(fs.readFileSync(this.schemaFile, 'utf8'));
    const relationships = this.extractRelationships(schema);
    
    if (relationships.length === 0) {
      console.log(`${colors.yellow}No relationships defined in schema${colors.reset}`);
      return;
    }
    
    const dbId = this.databaseId;
    
    for (const rel of relationships) {
      try {
        // Check if relationship already exists
        const existing = this.db.prepare(`
          SELECT * FROM relationships 
          WHERE from_collection = ? AND attribute_name = ?
        `).get(rel.from_collection, rel.attribute_name);
        
        if (existing) {
          console.log(`  ${colors.gray}○${colors.reset} Relationship already exists: ${rel.attribute_name}`);
          continue;
        }
        
        if (this.dryRun) {
          console.log(`  [dry-run] Would create relationship: ${rel.from_collection}.${rel.attribute_name} → ${rel.to_collection}`);
          continue;
        }
        
        execSync(`appwrite databases create-relationship-attribute \
          --database-id ${dbId} \
          --collection-id "${rel.from_collection}" \
          --related-collection-id "${rel.to_collection}" \
          --type "${rel.type}" \
          --key "${rel.attribute_name}" \
          ${rel.two_way_key ? `--two-way-key "${rel.two_way_key}"` : ''} \
          --on-delete "${rel.on_delete || 'restrict'}"`,
          { stdio: 'pipe' }
        );
        
        // Record in state DB
        this.db.prepare(`
          INSERT INTO relationships (id, from_collection, to_collection, type, attribute_name, two_way_key, on_delete)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          `${rel.from_collection}_${rel.attribute_name}`,
          rel.from_collection,
          rel.to_collection,
          rel.type,
          rel.attribute_name,
          rel.two_way_key || null,
          rel.on_delete || 'restrict'
        );
        
        console.log(`  ${colors.green}✓${colors.reset} Created relationship: ${rel.attribute_name}`);
      } catch (error) {
        console.error(`  ${colors.red}✗${colors.reset} Failed to create relationship: ${error.message}`);
      }
    }
  }

  async calculateChanges(schema) {
    const changes = {
      collections: [],
      attributes: [],
      indexes: []
    };
    
    // Get existing state from DB
    const existingColls = new Set(
      this.db.prepare('SELECT id FROM collections').all().map(r => r.id)
    );
    
    const existingAttrs = new Set(
      this.db.prepare('SELECT collection_id || "." || key as id FROM attributes').all().map(r => r.id)
    );
    
    const existingIndexes = new Set(
      this.db.prepare('SELECT collection_id || "." || key as id FROM indexes').all().map(r => r.id)
    );
    
    // Check collections
    for (const [name, coll] of Object.entries(schema.collections || {})) {
      const collId = this.toKebabCase(name);
      
      if (!existingColls.has(collId)) {
        changes.collections.push({
          id: collId,
          name: coll.name || name,
          ...coll
        });
      }
      
      // Check attributes
      for (const [attrName, attr] of Object.entries(coll.attributes || {})) {
        const attrId = `${collId}.${attrName}`;

        if (attr.decorators?.relationship) {
          continue;
        }

        if (!existingAttrs.has(attrId)) {
          changes.attributes.push({
            collection_id: collId,
            key: attrName,
            type: attr.type,
            array: !!attr.array,
            size: attr.size,
            required: !!attr.required,
            default: attr.default
          });
        }
      }

      // Check indexes
      for (const index of coll.indexes || []) {
        const indexAttributes = index.attributes || index.fields || [];
        const key = index.name || `idx_${indexAttributes.join('_')}`;
        const indexId = `${collId}.${key}`;

        if (!existingIndexes.has(indexId)) {
          changes.indexes.push({
            collection_id: collId,
            key,
            type: index.type || 'key',
            attributes: indexAttributes,
            orders: index.orders || []
          });
        }
      }
    }
    
    return changes;
  }

  extractRelationships(schema) {
    const relationships = [];
    
    for (const [collName, coll] of Object.entries(schema.collections || {})) {
      const collId = this.toKebabCase(collName);
      
      // Look for relationship decorators
      for (const [attrName, attr] of Object.entries(coll.attributes || {})) {
        if (attr.decorators?.relationship) {
          const rel = attr.decorators.relationship;
          relationships.push({
            from_collection: collId,
            to_collection: this.toKebabCase(rel.to || attr.type),
            type: rel.type || 'many-to-one',
            attribute_name: attrName,
            two_way_key: rel.twoWayKey,
            on_delete: rel.onDelete || 'restrict'
          });
        }
      }
      
      // Look for explicit relationships section
      for (const rel of coll.relationships || []) {
        relationships.push({
          from_collection: collId,
          to_collection: this.toKebabCase(rel.to),
          type: rel.type || 'many-to-one',
          attribute_name: rel.key,
          two_way_key: rel.twoWayKey,
          on_delete: rel.onDelete || 'restrict'
        });
      }
    }
    
    return relationships;
  }

  async status() {
    console.log(`${colors.cyan}Migration Status${colors.reset}\n`);
    
    const stats = {
      collections: this.db.prepare('SELECT COUNT(*) as count FROM collections').get().count,
      attributes: this.db.prepare('SELECT COUNT(*) as count FROM attributes').get().count,
      indexes: this.db.prepare('SELECT COUNT(*) as count FROM indexes').get().count,
      relationships: this.db.prepare('SELECT COUNT(*) as count FROM relationships').get().count,
      migrations: {
        applied: this.db.prepare('SELECT COUNT(*) as count FROM migrations WHERE status = "applied"').get().count,
        planned: this.db.prepare('SELECT COUNT(*) as count FROM migrations WHERE status = "planned"').get().count,
        failed: this.db.prepare('SELECT COUNT(*) as count FROM migrations WHERE status = "failed"').get().count,
        rolledBack: this.db.prepare('SELECT COUNT(*) as count FROM migrations WHERE status = "rolled_back"').get().count
      }
    };
    
    console.log(`${colors.bright}Database State:${colors.reset}`);
    console.log(`  Collections:   ${stats.collections}`);
    console.log(`  Attributes:    ${stats.attributes}`);
    console.log(`  Indexes:       ${stats.indexes}`);
    console.log(`  Relationships: ${stats.relationships}`);
    
    console.log(`\n${colors.bright}Migrations:${colors.reset}`);
    console.log(`  Applied: ${colors.green}${stats.migrations.applied}${colors.reset}`);
    console.log(`  Planned: ${colors.yellow}${stats.migrations.planned}${colors.reset}`);
    console.log(`  Failed:  ${colors.red}${stats.migrations.failed}${colors.reset}`);
    console.log(`  Rolled back: ${colors.blue}${stats.migrations.rolledBack}${colors.reset}`);
    
    const recent = this.db.prepare(`
      SELECT * FROM migrations 
      ORDER BY applied_at DESC 
      LIMIT 5
    `).all();
    
    if (recent.length > 0) {
      console.log(`\n${colors.bright}Recent Migrations:${colors.reset}`);
      for (const m of recent) {
        let icon = '○';
        let color = colors.yellow;
        if (m.status === 'applied') {
          icon = '✓';
          color = colors.green;
        } else if (m.status === 'failed') {
          icon = '✗';
          color = colors.red;
        } else if (m.status === 'rolled_back') {
          icon = '↺';
          color = colors.blue;
        }
        console.log(`  ${color}${icon}${colors.reset} ${m.id} - ${m.name} (${m.status})`);
      }
    }
  }

  async sync() {
    console.log(`${colors.cyan}Syncing with Appwrite...${colors.reset}\n`);
    
    // This would fetch the actual state from Appwrite and update the local DB
    // For now, just show a message
    console.log(`${colors.yellow}⚠ Sync not yet implemented${colors.reset}`);
    console.log(`This will fetch the current state from Appwrite and update the local tracking database.`);
  }

  async reset() {
    console.log(`${colors.red}⚠ WARNING: This will reset all migration tracking${colors.reset}\n`);
    
    const answer = await this.prompt('Type "reset" to confirm: ');
    if (answer !== 'reset') {
      console.log('Reset cancelled.');
      return;
    }
    
    this.db.exec(`
      DELETE FROM migrations;
      DELETE FROM relationships;
      DELETE FROM indexes;
      DELETE FROM attributes;
      DELETE FROM collections;
    `);
    
    console.log(`${colors.green}✓${colors.reset} Migration state reset`);
  }

  parseSchema(content) {
    const schema = {
      database: {},
      collections: {},
      enums: {}
    };
    
    const lines = content.split('\n');
    let currentBlock = null;
    let currentType = null;
    let bracketDepth = 0;
    
    for (const line of lines) {
      const trimmed = line.trim();
      
      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith('//')) continue;
      
      // Track bracket depth
      bracketDepth += (trimmed.match(/{/g) || []).length;
      bracketDepth -= (trimmed.match(/}/g) || []).length;
      
      // Database block
      if (trimmed.startsWith('database')) {
        currentBlock = 'database';
        currentType = null;
        continue;
      }
      
      // Collection block
      const collMatch = trimmed.match(/^collection\s+(\w+)\s*{?/);
      if (collMatch) {
        currentBlock = 'collection';
        currentType = collMatch[1];
        schema.collections[currentType] = {
          name: currentType,
          attributes: {},
          indexes: [],
          relationships: []
        };
        continue;
      }
      
      // End of block
      if (bracketDepth === 0) {
        currentBlock = null;
        currentType = null;
        continue;
      }
      
      // Parse content based on current block
      if (currentBlock === 'database') {
        const match = trimmed.match(/(\w+)\s*=\s*"([^"]+)"/);
        if (match) {
          schema.database[match[1]] = match[2];
        }
      } else if (currentBlock === 'collection' && currentType) {
        // Parse attributes
        const attrMatch = trimmed.match(/^(\w+)\s+(\w+)(\[\])?\s*(.*)/);
        if (attrMatch) {
          const [, name, type, isArray, decorators] = attrMatch;
          const decoratorData = this.parseDecorators(decorators);
          const normalizedDefault = this.normalizeDefaultValue(type, decoratorData.default);

          decoratorData.default = normalizedDefault;

          schema.collections[currentType].attributes[name] = {
            type,
            array: !!isArray,
            required: !!decoratorData.required,
            size: decoratorData.size,
            default: normalizedDefault,
            unique: !!decoratorData.unique,
            decorators: decoratorData
          };
        }

        // Parse indexes
        if (trimmed.startsWith('@@index')) {
          const indexMatch = trimmed.match(/@@index\(\[([^\]]+)\](?:,\s*([^)]+))?\)/);
          if (indexMatch) {
            const { fields, orders } = this.parseIndexFields(indexMatch[1]);
            let type = (indexMatch[2] || 'key').trim();
            if (['asc', 'desc'].includes(type.toLowerCase())) {
              if (fields.length > 0) {
                orders[0] = type.toLowerCase();
              }
              type = 'key';
            }
            schema.collections[currentType].indexes.push({
              fields,
              orders,
              type,
              attributes: fields
            });
          }
        }

        // Parse unique constraint
        if (trimmed.startsWith('@@unique')) {
          const uniqueMatch = trimmed.match(/@@unique\(\[([^\]]+)\]\)/);
          if (uniqueMatch) {
            const { fields, orders } = this.parseIndexFields(uniqueMatch[1]);
            schema.collections[currentType].indexes.push({
              fields,
              orders,
              type: 'unique',
              attributes: fields
            });
          }
        }
      }
    }
    
    return schema;
  }

  parseDecorators(decoratorString) {
    const decorators = {};
    const source = decoratorString || '';
    const regex = /@(\w+)(?:\(([^)]*)\))?/g;
    let match;
    
    while ((match = regex.exec(source)) !== null) {
      const [, name, params] = match;
      if (name === 'size' && params) {
        decorators.size = parseInt(params, 10);
      } else if (name === 'required') {
        decorators.required = true;
      } else if (name === 'unique') {
        decorators.unique = true;
      } else if (name === 'default') {
        decorators.default = params?.replace(/['"]/g, '');
      } else if (name === 'relationship') {
        // Parse relationship decorator
        decorators.relationship = this.parseRelationshipDecorator(params);
      } else {
        decorators[name] = params || true;
      }
    }
    
    return decorators;
  }

  parseRelationshipDecorator(params) {
    const rel = {};
    if (params) {
      const parts = params.split(',').map(p => p.trim());
      for (const part of parts) {
        const [key, value] = part.split(':').map(s => s.trim());
        rel[key] = value?.replace(/['"]/g, '');
      }
    }
    return rel;
  }

  parseIndexFields(fieldString) {
    const tokens = fieldString
      .split(',')
      .map(token => token.trim())
      .filter(Boolean);

    const fields = [];
    const orders = [];

    for (const token of tokens) {
      const lower = token.toLowerCase();
      if ((lower === 'asc' || lower === 'desc') && fields.length > 0) {
        orders[fields.length - 1] = lower;
      } else {
        fields.push(token);
        orders.push(null);
      }
    }

    return { fields, orders };
  }

  normalizeDefaultValue(type, value) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const lowerType = type.toLowerCase();
    const normalized = typeof value === 'string' ? value.trim() : value;

    if (lowerType === 'boolean' || lowerType === 'bool') {
      if (typeof normalized === 'boolean') return normalized;
      return ['true', '1', 'yes', 'on'].includes(String(normalized).toLowerCase());
    }

    if (lowerType === 'integer' || lowerType === 'int') {
      const parsed = parseInt(normalized, 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }

    if (lowerType === 'float' || lowerType === 'double') {
      const parsed = parseFloat(normalized);
      return Number.isNaN(parsed) ? undefined : parsed;
    }

    if (lowerType === 'datetime') {
      const val = String(normalized).toLowerCase();
      return val === 'now' ? 'now' : String(normalized);
    }

    return String(normalized);
  }

  formatCliValue(value, type) {
    if (value === undefined || value === null) {
      return null;
    }

    const lowerType = type.toLowerCase();

    if (lowerType === 'boolean' || lowerType === 'bool') {
      return value ? 'true' : 'false';
    }

    if (lowerType === 'integer' || lowerType === 'int' || lowerType === 'float' || lowerType === 'double') {
      return `${value}`;
    }

    if (lowerType === 'datetime' && String(value).toLowerCase() === 'now') {
      return 'now';
    }

    const str = String(value).replace(/"/g, '\\"');
    return `"${str}"`;
  }

  toKebabCase(str) {
    return str
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .toLowerCase();
  }

  generateChecksum(data) {
    return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
  }

  prompt(question) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    return new Promise(resolve => {
      rl.question(question, answer => {
        rl.close();
        resolve(answer);
      });
    });
  }

  showHelp() {
    console.log(`
${colors.cyan}AWM - Appwrite Migration Tool (Improved)${colors.reset}

${colors.bright}Usage:${colors.reset}
  awm <command> [options]

${colors.bright}Commands:${colors.reset}
  ${colors.cyan}init${colors.reset}          Initialize AWM in your project
  ${colors.cyan}plan${colors.reset}          Analyze schema and plan changes
  ${colors.cyan}apply${colors.reset}         Apply pending migrations
  ${colors.cyan}relationships${colors.reset} Apply relationship attributes (Phase 2)
  ${colors.cyan}status${colors.reset}        Show current state and migrations
  ${colors.cyan}sync${colors.reset}          Sync state with Appwrite
  ${colors.cyan}reset${colors.reset}         Reset all migration tracking
  
  ${colors.dim}Code Generation:${colors.reset}
  ${colors.cyan}generate-types${colors.reset}    Generate TypeScript types from schema
  ${colors.cyan}generate-zod${colors.reset}      Generate Zod validation schemas
  ${colors.cyan}generate${colors.reset}          Generate both types and Zod schemas

${colors.bright}Options:${colors.reset}
  --dry-run      Show what would be done without making changes
  --yes          Skip confirmation prompts
  --force        Continue on errors

${colors.bright}Configuration (awm.config.json):${colors.reset}
  {
    "schemaPath": "appwrite.schema",
    "migrationsDir": "migrations",
    "stateDb": ".awm-state.db",
    "databaseId": "my-database",
    "projectId": "your-project-id",
    "endpoint": "https://cloud.appwrite.io/v1"
  }

${colors.bright}Schema Example:${colors.reset}
  collection Users {
    name        String   @size(255) @required
    email       String   @size(255) @unique
    posts       Post[]   @relationship(type: "one-to-many", to: "Posts")
    
    @@index([email])
  }
`);
  }
}

const main = async () => {
  const awm = new AWMImproved();
  await awm.run();
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ Error:', error.message);
    if (error.stack && process.env.AWM_DEBUG === 'true') {
      console.error(error.stack);
    }
    process.exit(1);
  });
}
