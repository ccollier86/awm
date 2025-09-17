#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import crypto from 'crypto';
import readline from 'readline';
import dotenv from 'dotenv';

import {
  AppwriteClient,
  AppwriteStateStore,
  AppwriteLockManager,
  AppwriteSchemaInspector
} from './lib/appwrite.js';

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

    this.schemaFile = path.resolve(this.root, process.env.AWM_SCHEMA || this.config.schemaPath || 'appwrite.schema');

    this.appwriteProject = process.env.APPWRITE_PROJECT_ID || this.config.projectId;
    this.appwriteEndpoint = process.env.APPWRITE_ENDPOINT || this.config.endpoint || 'http://localhost/v1';
    this.appwriteKey = process.env.APPWRITE_API_KEY || this.config.apiKey;
    this.databaseId = process.env.APPWRITE_DATABASE_ID || this.config.databaseId || this.extractDatabaseId();

    this.dryRun = false;
    this.debug = process.env.AWM_DEBUG === 'true' || this.config.debug;
    this.force = false;
    this.lockOwner = process.env.AWM_LOCK_OWNER || os.hostname();

    this.appwriteClient = new AppwriteClient({
      endpoint: this.appwriteEndpoint,
      projectId: this.appwriteProject,
      apiKey: this.appwriteKey
    });

    this.stateStore = new AppwriteStateStore({
      client: this.appwriteClient,
      databaseId: this.databaseId
    });

    this.lockManager = new AppwriteLockManager({
      client: this.appwriteClient,
      databaseId: this.databaseId
    });

    this.schemaInspector = new AppwriteSchemaInspector({
      client: this.appwriteClient,
      databaseId: this.databaseId
    });

    this.ready = this.bootstrap();

    const argv = process.argv.slice(2);
    this.command = argv[0];
    this.args = argv.slice(1);

    for (let i = 0; i < this.args.length; i++) {
      const arg = this.args[i];
      if (arg === '--dry-run') this.dryRun = true;
      if (arg === '--force') this.force = true;
      if (arg === '--yes') this.nonInteractive = true;
    }
  }

  async bootstrap() {
    if (!this.appwriteProject || !this.appwriteKey) {
      return;
    }

    try {
      await this.stateStore.init();
      await this.lockManager.init();
    } catch (error) {
      console.error(`${colors.red}Failed to initialise Appwrite state: ${error.message}${colors.reset}`);
    }
  }

  loadConfig() {
    const configLocations = [
      path.join(this.root, 'awm.config.json'),
      path.join(this.root, '.awm.json'),
      path.join(this.root, 'config', 'awm.json'),
      path.join(this.root, '.config', 'awm.json')
    ];

    for (const configFile of configLocations) {
      if (fs.existsSync(configFile)) {
        return JSON.parse(fs.readFileSync(configFile, 'utf8'));
      }
    }

    const envFile = path.join(this.root, '.env');
    if (fs.existsSync(envFile)) {
      dotenv.config({ path: envFile });
    }

    return {};
  }

  extractDatabaseId() {
    if (!fs.existsSync(this.schemaFile)) return 'database';
    const content = fs.readFileSync(this.schemaFile, 'utf8');
    const match = content.match(/database\s*{[^}]*id\s*=\s*"([^"]+)"/);
    return match ? match[1] : 'database';
  }

  async run() {
    await this.ready;

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
      case 'relationships':
        await this.applyRelationships();
        break;
      case 'rollback':
        await this.rollback();
        break;
      case 'status':
        await this.status();
        break;
      case 'reset':
        await this.reset();
        break;
      case 'generate-types':
        await this.generateTypes(this.firstPositionalArg() || './types/appwrite.types.ts');
        break;
      case 'generate-zod':
        await this.generateZod(this.firstPositionalArg() || './types/appwrite.zod.ts');
        break;
      case 'generate':
        await this.generateArtifacts('./types/appwrite.types.ts', './types/appwrite.zod.ts');
        break;
      default:
        this.showHelp();
    }
  }

  firstPositionalArg() {
    return this.args.find(a => !a.startsWith('--'));
  }

  async init() {
    console.log(`${colors.cyan}Initializing AWM in ${this.root}${colors.reset}`);
    const { default: initProject } = await import('./init.js');
    await initProject();
    console.log(`\n${colors.green}✓ Initialization completed${colors.reset}`);
  }

  async plan() {
    this.ensureConfig();
    const schema = this.parseSchema(fs.readFileSync(this.schemaFile, 'utf8'));
    const changes = await this.calculateChanges(schema);
    const relationships = await this.calculateRelationships(schema);

    if (changes.collections.length === 0 && changes.attributes.length === 0 && changes.indexes.length === 0 && relationships.length === 0) {
      console.log(`${colors.green}✓${colors.reset} Schema is already in sync.`);
      return;
    }

    console.log(`${colors.yellow}Planned changes:${colors.reset}`);
    if (changes.collections.length) {
      console.log(`${colors.bright}Collections:${colors.reset}`);
      for (const coll of changes.collections) {
        console.log(`  ${colors.green}+${colors.reset} ${coll.name} (${coll.id})`);
      }
    }

    if (changes.attributes.length) {
      console.log(`\n${colors.bright}Attributes:${colors.reset}`);
      for (const attr of changes.attributes) {
        console.log(`  ${colors.green}+${colors.reset} ${attr.collection_id}.${attr.key} (${attr.type}${attr.array ? '[]' : ''})`);
      }
    }

    if (changes.indexes.length) {
      console.log(`\n${colors.bright}Indexes:${colors.reset}`);
      for (const idx of changes.indexes) {
        console.log(`  ${colors.green}+${colors.reset} ${idx.collection_id}.${idx.key}`);
      }
    }

    if (relationships.length) {
      console.log(`\n${colors.bright}Relationships:${colors.reset}`);
      for (const rel of relationships) {
        console.log(`  ${colors.green}+${colors.reset} ${rel.collection}.${rel.key} → ${rel.to_collection} (${rel.type})`);
      }
    }

    if (this.dryRun) {
      console.log(`\n${colors.gray}Dry run - no changes scheduled${colors.reset}`);
    }
  }

  async apply() {
    this.ensureConfig();

    await this.withLock('schema-apply', async () => {
      const schema = this.parseSchema(fs.readFileSync(this.schemaFile, 'utf8'));
      const changes = await this.calculateChanges(schema);

      if (changes.collections.length === 0 && changes.attributes.length === 0 && changes.indexes.length === 0) {
        console.log(`${colors.green}✓${colors.reset} Nothing to apply.`);
        return;
      }

      if (this.dryRun) {
        console.log(`${colors.gray}Dry run - skipping apply${colors.reset}`);
        return;
      }

      console.log(`${colors.cyan}Applying schema changes...${colors.reset}\n`);
      await this.applyChanges(changes);

      const checksum = this.generateChecksum(changes);
      await this.stateStore.recordHistory({
        type: 'apply',
        databaseId: this.databaseId,
        checksum,
        changes: this.compactChanges(changes)
      });

      console.log(`\n${colors.green}✓ Apply completed${colors.reset}`);
    });
  }

  async applyRelationships() {
    this.ensureConfig();

    await this.withLock('schema-relationships', async () => {
      const schema = this.parseSchema(fs.readFileSync(this.schemaFile, 'utf8'));
      const relationships = await this.calculateRelationships(schema);

      if (!relationships.length) {
        console.log(`${colors.green}✓${colors.reset} No relationship changes needed.`);
        return;
      }

      if (this.dryRun) {
        console.log(`${colors.gray}Dry run - skipping relationships${colors.reset}`);
        return;
      }

      console.log(`${colors.cyan}Applying relationship attributes...${colors.reset}\n`);
      for (const rel of relationships) {
        try {
          const relType = (rel.type || 'many-to-one')
            .split('-')
            .map((part, index) => index === 0 ? part.toLowerCase() : part.charAt(0).toUpperCase() + part.slice(1))
            .join('');
          const twoWay = rel.two_way_key ? '--two-way true' : '';
          const twoWayKeyArg = rel.two_way_key ? `--two-way-key "${rel.two_way_key}"` : '';
          execSync(`appwrite databases create-relationship-attribute \
            --database-id ${this.databaseId} \
            --collection-id "${rel.collection}" \
            --related-collection-id "${rel.to_collection}" \
            --type "${relType}" \
            --key "${rel.key}" \
            ${twoWayKeyArg} \
            ${twoWay} \
            --on-delete "${rel.on_delete || 'restrict'}"`, { stdio: 'pipe' });
          console.log(`  ${colors.green}✓${colors.reset} Relationship ${rel.collection}.${rel.key}`);
        } catch (error) {
          if (error.stderr?.toString()?.includes('already exists')) {
            console.log(`  ${colors.gray}○${colors.reset} Relationship already exists: ${rel.collection}.${rel.key}`);
          } else {
            throw error;
          }
        }
      }

        await this.stateStore.recordHistory({
          type: 'relationships',
          databaseId: this.databaseId,
          relationships: relationships.map(rel => ({
            collection: rel.collection,
            key: rel.key,
            to_collection: rel.to_collection,
            type: rel.type,
            twoWayKey: rel.two_way_key || null
          }))
        });

      console.log(`\n${colors.green}✓ Relationships applied${colors.reset}`);
    });
  }

  async rollback() {
    this.ensureConfig();

    await this.withLock('schema-rollback', async () => {
      const history = await this.stateStore.latestHistory('applied');
      if (!history) {
        console.log(`${colors.yellow}No applied migrations found to roll back.${colors.reset}`);
        return;
      }

      const payload = history.payload || {};
      if (payload.type !== 'apply') {
        console.log(`${colors.yellow}Latest history entry is not an apply run. Nothing to roll back.${colors.reset}`);
        return;
      }

      const changes = payload.changes || {};
      const { indexes = [], attributes = [], collections = [] } = changes;

      if (this.dryRun) {
        console.log(`${colors.gray}Dry run - rollback would remove:${colors.reset}`);
        collections.forEach(coll => console.log(`  ${colors.red}-${colors.reset} collection ${coll.id}`));
        attributes.forEach(attr => console.log(`  ${colors.red}-${colors.reset} attribute ${attr.collection_id}.${attr.key}`));
        indexes.forEach(idx => console.log(`  ${colors.red}-${colors.reset} index ${idx.collection_id}.${idx.key}`));
        return;
      }

      console.log(`${colors.cyan}Rolling back last apply...${colors.reset}`);

      for (const idx of indexes) {
        try {
          execSync(`appwrite databases delete-index \
            --database-id ${this.databaseId} \
            --collection-id "${idx.collection_id}" \
            --key "${idx.key}"`, { stdio: 'pipe' });
          console.log(`  ${colors.red}-${colors.reset} index ${idx.collection_id}.${idx.key}`);
        } catch (error) {
          console.log(`  ${colors.gray}○${colors.reset} index already removed: ${idx.collection_id}.${idx.key}`);
        }
      }

      for (const attr of attributes) {
        try {
          execSync(`appwrite databases delete-attribute \
            --database-id ${this.databaseId} \
            --collection-id "${attr.collection_id}" \
            --key "${attr.key}"`, { stdio: 'pipe' });
          console.log(`  ${colors.red}-${colors.reset} attribute ${attr.collection_id}.${attr.key}`);
        } catch (error) {
          console.log(`  ${colors.gray}○${colors.reset} attribute already removed: ${attr.collection_id}.${attr.key}`);
        }
      }

      for (const coll of collections) {
        try {
          execSync(`appwrite databases delete-collection \
            --database-id ${this.databaseId} \
            --collection-id "${coll.id}"`, { stdio: 'pipe' });
          console.log(`  ${colors.red}-${colors.reset} collection ${coll.id}`);
        } catch (error) {
          console.log(`  ${colors.gray}○${colors.reset} collection already removed: ${coll.id}`);
        }
      }

      await this.stateStore.updateHistoryStatus(history.recordId, 'rolled_back');
      console.log(`\n${colors.green}✓ Rollback complete${colors.reset}`);
    });
  }

  async status() {
    this.ensureConfig();

    const remote = await this.schemaInspector.describe();
    const collectionCount = remote.size;
    let attributeCount = 0;
    let indexCount = 0;
    for (const { attributes, indexes } of remote.values()) {
      attributeCount += attributes.length;
      indexCount += indexes.length;
    }

    console.log(`${colors.cyan}Database Status${colors.reset}`);
    console.log(`  Collections: ${collectionCount}`);
    console.log(`  Attributes:  ${attributeCount}`);
    console.log(`  Indexes:     ${indexCount}`);

    const histories = await this.stateStore.listRecords('history');
    if (histories.length) {
      console.log(`\n${colors.bright}Recent history:${colors.reset}`);
      histories
        .sort((a, b) => (a.createdAt > b.createdAt ? -1 : 1))
        .slice(0, 5)
        .forEach(entry => {
          const summary = entry.payload?.type || 'unknown';
          console.log(`  ${entry.createdAt}: ${summary} (${entry.status || 'unknown'})`);
        });
    }
  }

  async reset() {
    this.ensureConfig();

    await this.withLock('schema-reset', async () => {
      if (!this.nonInteractive) {
        const confirmed = await this.prompt('This will clear migration history. Continue? (y/N): ');
        if (!['y', 'yes'].includes((confirmed || '').toLowerCase())) {
          console.log('Reset cancelled.');
          return;
        }
      }

      await this.stateStore.reset();
      console.log(`${colors.green}✓ State cleared${colors.reset}`);
    });
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

  async withLock(lockId, fn) {
    if (!this.appwriteProject || !this.appwriteKey) {
      throw new Error('Appwrite credentials are required for this operation');
    }

    await this.lockManager.acquire(lockId, { owner: this.lockOwner, force: this.force });
    try {
      return await fn();
    } finally {
      await this.lockManager.release(lockId, this.lockOwner);
    }
  }

  ensureConfig() {
    if (!this.appwriteProject) {
      throw new Error('APPWRITE_PROJECT_ID is required');
    }
    if (!this.appwriteKey) {
      throw new Error('APPWRITE_API_KEY is required');
    }
    if (!this.databaseId) {
      throw new Error('APPWRITE_DATABASE_ID is required');
    }
  }

  async calculateChanges(schema) {
    const remote = await this.schemaInspector.describe();

    const changes = {
      collections: [],
      attributes: [],
      indexes: []
    };

    for (const [name, coll] of Object.entries(schema.collections || {})) {
      const collId = this.toKebabCase(name);
      const remoteColl = remote.get(collId);

      if (!remoteColl) {
        changes.collections.push({
          id: collId,
          name: coll.name || name,
          attributes: coll.attributes,
          indexes: coll.indexes
        });
        continue;
      }

      const remoteAttributes = new Map();
      for (const attr of remoteColl.attributes || []) {
        remoteAttributes.set(attr.key, attr);
      }

      for (const [attrName, attr] of Object.entries(coll.attributes || {})) {
        if (attr.decorators?.relationship) continue;
        if (!remoteAttributes.has(attrName)) {
          changes.attributes.push({
            collection_id: collId,
            key: attrName,
            type: attr.type,
            array: !!attr.array,
            required: !!attr.required,
            size: attr.size,
            default: attr.default
          });
        }
      }

      const remoteIndexes = new Map();
      for (const idx of remoteColl.indexes || []) {
        remoteIndexes.set(idx.key, idx);
      }

      for (const index of coll.indexes || []) {
        const rawKey = index.name || `idx_${(index.attributes || index.fields || []).join('_')}`;
        const key = this.sanitizeIndexKey(rawKey);
        if (!remoteIndexes.has(key)) {
          changes.indexes.push({
            collection_id: collId,
            key,
            type: index.type || 'key',
            attributes: index.attributes || index.fields || [],
            orders: index.orders || []
          });
        }
      }
    }

    return changes;
  }

  compactChanges(changes = {}) {
    return {
      collections: (changes.collections || []).map(coll => ({
        id: coll.id,
        name: coll.name
      })),
      attributes: (changes.attributes || []).map(attr => ({
        collection_id: attr.collection_id,
        key: attr.key
      })),
      indexes: (changes.indexes || []).map(idx => ({
        collection_id: idx.collection_id,
        key: this.sanitizeIndexKey(idx.key)
      }))
    };
  }

  async calculateRelationships(schema) {
    const remote = await this.schemaInspector.describe();
    const pending = [];

    for (const [name, coll] of Object.entries(schema.collections || {})) {
      const collId = this.toKebabCase(name);
      const remoteColl = remote.get(collId);
      const remoteRelationshipKeys = new Set(
        (remoteColl?.attributes || [])
          .filter(attr => attr.type === 'relationship')
          .map(attr => attr.key)
      );

      for (const [attrName, attr] of Object.entries(coll.attributes || {})) {
        const rel = attr.decorators?.relationship;
        if (!rel) continue;
        if (remoteRelationshipKeys.has(attrName)) continue;

        pending.push({
          collection: collId,
          key: attrName,
          to_collection: this.toKebabCase(rel.to || attr.type),
          type: rel.type || 'many-to-one',
          two_way_key: rel.twoWayKey,
          on_delete: rel.onDelete || 'restrict'
        });
      }
    }

    return pending;
  }

  async applyChanges(changes) {
    const dbId = this.databaseId;

    for (const coll of changes.collections || []) {
      try {
        execSync(`appwrite databases create-collection \
          --database-id ${dbId} \
          --collection-id "${coll.id}" \
          --name "${coll.name}" \
          --enabled true`, { stdio: 'pipe' });
        console.log(`  ${colors.green}✓${colors.reset} Created collection ${coll.name}`);
      } catch (error) {
        if (error.stderr?.toString()?.includes('already exists')) {
          console.log(`  ${colors.gray}○${colors.reset} Collection already exists: ${coll.name}`);
        } else {
          throw error;
        }
      }
    }

    for (const attr of changes.attributes || []) {
      try {
        const cmd = this.buildAttributeCommand(dbId, attr);
        execSync(cmd, { stdio: 'pipe' });
        console.log(`  ${colors.green}✓${colors.reset} Created attribute ${attr.collection_id}.${attr.key}`);
      } catch (error) {
        if (error.stderr?.toString()?.includes('already exists')) {
          console.log(`  ${colors.gray}○${colors.reset} Attribute already exists: ${attr.collection_id}.${attr.key}`);
        } else {
          throw error;
        }
      }
    }

    for (const idx of changes.indexes || []) {
      try {
        const indexKey = this.sanitizeIndexKey(idx.key);
        if (this.debug) {
          console.log(`  creating index ${idx.collection_id}.${indexKey} (${idx.type})`);
        }
        await this.appwriteClient.ensureIndex(dbId, idx.collection_id, {
          key: indexKey,
          type: idx.type || 'key',
          attributes: idx.attributes || [],
          orders: (idx.orders || []).filter(Boolean)
        });
        console.log(`  ${colors.green}✓${colors.reset} Created index ${idx.collection_id}.${indexKey}`);
      } catch (error) {
        if (error.status === 409) {
          console.log(`  ${colors.gray}○${colors.reset} Index already exists: ${idx.collection_id}.${idx.key}`);
        } else {
          throw error;
        }
      }
    }
  }

  buildAttributeCommand(dbId, attr) {
    const base = `appwrite databases`;
    const common = `--database-id ${dbId} --collection-id "${attr.collection_id}" --key "${attr.key}"`;
    const req = attr.required ? '--required true' : '--required false';
    const arr = attr.array ? '--array true' : '--array false';
    const type = attr.type.toLowerCase();
    const size = attr.size || 255;

    switch (type) {
      case 'string':
        return `${base} create-string-attribute ${common} --size ${size} ${req} ${arr}`;
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
        throw new Error(`Unsupported attribute type: ${attr.type}`);
    }
  }

  async loadGenerators() {
    const [types, zod] = await Promise.all([
      import('./type-generator.js'),
      import('./zod-generator.js')
    ]);

    return {
      TypeGenerator: types.TypeGenerator,
      ZodGenerator: zod.ZodGenerator
    };
  }

  parseSchema(content) {
    const schema = {
      databases: new Map(),
      collections: {}
    };

    const lines = content.split('\n');
    let currentBlock = null;
    let currentCollection = null;
    let currentDatabase = null;
    let bracketDepth = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//')) continue;

      bracketDepth += (trimmed.match(/{/g) || []).length;
      bracketDepth -= (trimmed.match(/}/g) || []).length;

      if (trimmed.startsWith('database')) {
        currentBlock = 'database';
        currentCollection = null;
        currentDatabase = {};
        continue;
      }

      const collMatch = trimmed.match(/^collection\s+(\w+)/);
      if (collMatch) {
        currentBlock = 'collection';
        currentCollection = collMatch[1];
        schema.collections[currentCollection] = {
          name: currentCollection,
          attributes: {},
          indexes: []
        };
        continue;
      }

      if (bracketDepth === 0) {
        if (currentBlock === 'database' && currentDatabase?.id) {
          schema.databases.set(currentDatabase.id, currentDatabase);
        }
        currentBlock = null;
        currentCollection = null;
        currentDatabase = null;
        continue;
      }

      if (currentBlock === 'database') {
        const match = trimmed.match(/(\w+)\s*=\s*"([^"]+)"/);
        if (match) {
          currentDatabase[match[1]] = match[2];
        }
        continue;
      }

      if (currentBlock === 'collection' && currentCollection) {
        const attrMatch = trimmed.match(/^(\w+)\s+(\w+)(\[\])?\s*(.*)/);
        if (attrMatch) {
          const [, name, type, isArray, decorators] = attrMatch;
          const decoratorData = this.parseDecorators(decorators);
          const normalizedDefault = this.normalizeDefaultValue(type, decoratorData.default);
          decoratorData.default = normalizedDefault;

          schema.collections[currentCollection].attributes[name] = {
            type,
            array: !!isArray,
            required: !!decoratorData.required,
            size: decoratorData.size,
            default: normalizedDefault,
            decorators: decoratorData
          };
          continue;
        }

        if (trimmed.startsWith('@@index')) {
          const indexMatch = trimmed.match(/@@index\(\[([^\]]+)\](?:,\s*([^)]+))?\)/);
          if (indexMatch) {
            const { fields, orders } = this.parseIndexFields(indexMatch[1]);
            let type = (indexMatch[2] || 'key').trim();
            if (['asc', 'desc'].includes(type.toLowerCase())) {
              if (fields.length > 0) orders[0] = type.toLowerCase();
              type = 'key';
            }
            schema.collections[currentCollection].indexes.push({
              attributes: fields,
              orders,
              type
            });
          }
          continue;
        }

        if (trimmed.startsWith('@@unique')) {
          const uniqueMatch = trimmed.match(/@@unique\(\[([^\]]+)\]\)/);
          if (uniqueMatch) {
            const { fields, orders } = this.parseIndexFields(uniqueMatch[1]);
            schema.collections[currentCollection].indexes.push({
              attributes: fields,
              orders,
              type: 'unique'
            });
          }
          continue;
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
      const [, name, paramsRaw] = match;
      const params = paramsRaw || '';
      if (name === 'size' && params) {
        decorators.size = parseInt(params, 10);
      } else if (name === 'required') {
        decorators.required = true;
      } else if (name === 'unique') {
        decorators.unique = true;
      } else if (name === 'default') {
        decorators.default = params.replace(/['"]/g, '');
      } else if (name === 'relationship') {
        decorators.relationship = this.parseRelationshipDecorator(params);
      } else {
        decorators[name] = params || true;
      }
    }

    return decorators;
  }

  parseRelationshipDecorator(params) {
    const rel = {};
    if (!params) return rel;
    const parts = params.split(',').map(p => p.trim());
    for (const part of parts) {
      const [key, value] = part.split(':').map(x => x.trim());
      rel[key] = value?.replace(/['"]/g, '');
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
      if ((lower === 'asc' || lower === 'desc') && fields.length) {
        orders[fields.length - 1] = lower === 'desc' ? 'DESC' : 'ASC';
      } else {
        fields.push(token);
        orders.push(null);
      }
    }

    return { fields, orders };
  }

  normalizeDefaultValue(type, value) {
    if (value === undefined || value === null || value === '') return undefined;
    const lowerType = type.toLowerCase();
    if (lowerType === 'boolean' || lowerType === 'bool') {
      return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
    }
    if (lowerType === 'integer' || lowerType === 'int') {
      const parsed = parseInt(value, 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    if (lowerType === 'float' || lowerType === 'double') {
      const parsed = parseFloat(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return String(value);
  }

  toKebabCase(str) {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase();
  }

  sanitizeIndexKey(key) {
    const cleaned = (key || '')
      .replace(/^[^a-zA-Z0-9]+/, '')
      .replace(/[^a-zA-Z0-9._-]/g, '_') || 'idx_hash';

    if (cleaned.length <= 36) {
      return cleaned;
    }

    const hash = crypto.createHash('md5').update(cleaned).digest('hex').slice(0, 28);
    return `idx_${hash}`;
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
${colors.cyan}AWM - Appwrite Migration Tool${colors.reset}

Usage: awm <command> [options]

Commands:
  ${colors.cyan}plan${colors.reset}             Show pending schema changes
  ${colors.cyan}apply${colors.reset}            Apply collections/attributes/indexes
  ${colors.cyan}relationships${colors.reset}    Apply relationship attributes
  ${colors.cyan}status${colors.reset}           Display database summary
  ${colors.cyan}rollback${colors.reset}         Revert the last apply run
  ${colors.cyan}reset${colors.reset}            Clear migration history
  ${colors.cyan}generate-types${colors.reset}   Generate TypeScript types
  ${colors.cyan}generate-zod${colors.reset}     Generate Zod schemas
  ${colors.cyan}generate${colors.reset}         Generate both types and Zod schemas
`);
  }
}

const main = async () => {
  const awm = new AWMImproved();
  try {
    await awm.run();
  } catch (error) {
    console.error(`${colors.red}✗ ${error.message}${colors.reset}`);
    if (process.env.AWM_DEBUG === 'true' && error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
