#!/usr/bin/env node
"use strict";

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

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const readline = require('readline');

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
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
      require('dotenv').config({ path: envFile });
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
          await this.rollback(this.args[0]);
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
        default:
          this.showHelp();
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

  async init() {
    console.log(`${colors.cyan}Initializing AWM in ${this.root}${colors.reset}\n`);
    
    // Check if we have required env vars
    const hasEnvConfig = process.env.APPWRITE_PROJECT_ID && process.env.APPWRITE_ENDPOINT;
    
    // Create example config file if no config exists and no env vars
    const configFile = path.join(this.root, 'awm.config.json');
    if (!fs.existsSync(configFile) && !hasEnvConfig) {
      const exampleConfig = {
        "_comment": "AWM Config - ENV vars override these settings",
        "schemaPath": "appwrite.schema",
        "migrationsDir": "migrations",
        "endpoint": "http://localhost/v1",
        "projectId": "your-project-id",
        "apiKey": "your-api-key-if-needed",
        "databaseId": null,
        "debug": false
      };
      fs.writeFileSync(configFile, JSON.stringify(exampleConfig, null, 2));
      console.log(`${colors.green}✓${colors.reset} Created example awm.config.json`);
      console.log(`${colors.yellow}⚠${colors.reset} Set APPWRITE_PROJECT_ID and APPWRITE_ENDPOINT env vars`);
      console.log(`   or update awm.config.json with your project details`);
    } else if (hasEnvConfig) {
      console.log(`${colors.green}✓${colors.reset} Using environment variables for configuration`);
    }

    // Create example schema if it doesn't exist
    if (!fs.existsSync(this.schemaFile)) {
      const exampleSchema = `// Appwrite Schema Definition
database {
  name = "my-database"
  id   = "my-database"
}

collection Users {
  name            String   @size(255) @required
  email           String   @size(255) @required @unique
  created_at      DateTime @default(now)
  
  @@index([email])
}`;
      fs.writeFileSync(this.schemaFile, exampleSchema);
      console.log(`${colors.green}✓${colors.reset} Created example schema file`);
    }

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

  async applyChanges(changes) {
    const dbId = this.config.databaseId || 'database';
    
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
        const attrs = idx.attributes.join(',');
        execSync(`appwrite databases create-index \
          --database-id ${dbId} \
          --collection-id "${idx.collection_id}" \
          --key "${idx.key}" \
          --type "${idx.type}" \
          --attributes "${attrs}"`,
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
          attrs
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

  buildAttributeCommand(dbId, attr) {
    const base = `appwrite databases`;
    const common = `--database-id ${dbId} --collection-id "${attr.collection_id}" --key "${attr.key}"`;
    const req = attr.required ? '--required true' : '--required false';
    const arr = attr.array ? '--array true' : '--array false';
    
    switch (attr.type.toLowerCase()) {
      case 'string':
        return `${base} create-string-attribute ${common} --size ${attr.size || 255} ${req} ${arr}`;
      case 'integer':
      case 'int':
        return `${base} create-integer-attribute ${common} ${req} ${arr}`;
      case 'float':
      case 'double':
        return `${base} create-float-attribute ${common} ${req} ${arr}`;
      case 'boolean':
      case 'bool':
        return `${base} create-boolean-attribute ${common} ${req} ${arr}`;
      case 'datetime':
        return `${base} create-datetime-attribute ${common} ${req} ${arr}`;
      case 'email':
        return `${base} create-email-attribute ${common} ${req} ${arr}`;
      case 'url':
        return `${base} create-url-attribute ${common} ${req} ${arr}`;
      default:
        throw new Error(`Unknown attribute type: ${attr.type}`);
    }
  }

  async applyRelationships() {
    console.log(`${colors.cyan}Applying relationships (Phase 2)...${colors.reset}\n`);
    
    const schema = this.parseSchema(fs.readFileSync(this.schemaFile, 'utf8'));
    const relationships = this.extractRelationships(schema);
    
    if (relationships.length === 0) {
      console.log(`${colors.yellow}No relationships defined in schema${colors.reset}`);
      return;
    }
    
    const dbId = this.config.databaseId || 'database';
    
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
        
        if (!existingAttrs.has(attrId)) {
          changes.attributes.push({
            collection_id: collId,
            key: attrName,
            ...attr
          });
        }
      }
      
      // Check indexes
      for (const index of coll.indexes || []) {
        const indexId = `${collId}.${index.name || index.attributes.join('_')}`;
        
        if (!existingIndexes.has(indexId)) {
          changes.indexes.push({
            collection_id: collId,
            key: index.name || `idx_${index.attributes.join('_')}`,
            type: index.type || 'key',
            attributes: index.attributes || index.fields
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
        failed: this.db.prepare('SELECT COUNT(*) as count FROM migrations WHERE status = "failed"').get().count
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
    
    const recent = this.db.prepare(`
      SELECT * FROM migrations 
      ORDER BY applied_at DESC 
      LIMIT 5
    `).all();
    
    if (recent.length > 0) {
      console.log(`\n${colors.bright}Recent Migrations:${colors.reset}`);
      for (const m of recent) {
        const icon = m.status === 'applied' ? '✓' : m.status === 'failed' ? '✗' : '○';
        const color = m.status === 'applied' ? colors.green : m.status === 'failed' ? colors.red : colors.yellow;
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
          schema.collections[currentType].attributes[name] = {
            type,
            array: !!isArray,
            decorators: this.parseDecorators(decorators)
          };
        }
        
        // Parse indexes
        if (trimmed.startsWith('@@index')) {
          const indexMatch = trimmed.match(/@@index\(\[([^\]]+)\](?:,\s*(\w+))?\)/);
          if (indexMatch) {
            const fields = indexMatch[1].split(',').map(f => f.trim());
            const type = indexMatch[2] || 'key';
            schema.collections[currentType].indexes.push({
              fields,
              type,
              attributes: fields
            });
          }
        }
        
        // Parse unique constraint
        if (trimmed.startsWith('@@unique')) {
          const uniqueMatch = trimmed.match(/@@unique\(\[([^\]]+)\]\)/);
          if (uniqueMatch) {
            const fields = uniqueMatch[1].split(',').map(f => f.trim());
            schema.collections[currentType].indexes.push({
              fields,
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
    const regex = /@(\w+)(?:\(([^)]*)\))?/g;
    let match;
    
    while ((match = regex.exec(decoratorString)) !== null) {
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

// Run the tool
const awm = new AWMImproved();

// Import generators dynamically
const loadGenerators = async () => {
  const TypeGenerator = (await import('./type-generator.js')).default;
  const ZodGenerator = (await import('./zod-generator.js')).default;
  return { TypeGenerator, ZodGenerator };
};

// Main CLI execution
(async () => {
  const command = process.argv[2];
  const args = process.argv.slice(3);
  
  try {
    switch (command) {
      case 'init':
        const { default: initProject } = await import('./init.js');
        await initProject();
        break;
        
      case 'apply':
        await awm.apply();
        break;
        
      case 'relationships':
        await awm.applyRelationships();
        break;
        
      case 'status':
        await awm.status();
        break;
        
      case 'rollback':
        await awm.rollback(args[0]);
        break;
        
      case 'generate-types':
        const { TypeGenerator } = await loadGenerators();
        const typeGen = new TypeGenerator(awm.schemaFile);
        const outputPath = args[0] || './types/appwrite.types.ts';
        await typeGen.generate(outputPath);
        break;
        
      case 'generate-zod':
        const { ZodGenerator } = await loadGenerators();
        const zodGen = new ZodGenerator(awm.schemaFile);
        const zodOutputPath = args[0] || './schemas/appwrite.schemas.ts';
        await zodGen.generate(zodOutputPath);
        break;
        
      case 'generate':
        // Generate both types and schemas
        const generators = await loadGenerators();
        
        console.log('\n🚀 Generating TypeScript types and Zod schemas...\n');
        
        const typeGenerator = new generators.TypeGenerator(awm.schemaFile);
        await typeGenerator.generate(args[0] || './types/appwrite.types.ts');
        
        const zodGenerator = new generators.ZodGenerator(awm.schemaFile);
        await zodGenerator.generate(args[1] || './schemas/appwrite.schemas.ts');
        
        console.log('\n✨ All generators completed successfully!');
        break;
        
      case 'help':
      case undefined:
        awm.printHelp();
        break;
        
      default:
        console.error(`Unknown command: ${command}`);
        awm.printHelp();
        process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.stack && process.env.AWM_DEBUG === 'true') {
      console.error(error.stack);
    }
    process.exit(1);
  }
})();