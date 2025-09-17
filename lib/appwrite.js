import crypto from 'crypto';

class AppwriteError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'AppwriteError';
    this.status = status;
    this.payload = payload;
  }
}

export class AppwriteClient {
  constructor({ endpoint, projectId, apiKey }) {
    this.endpoint = endpoint?.replace(/\/$/, '') || 'http://localhost/v1';
    this.projectId = projectId;
    this.apiKey = apiKey;
  }

  async request({ method = 'GET', path, body, searchParams }) {
    if (!this.projectId || !this.apiKey) {
      throw new Error('Appwrite credentials are not configured');
    }

    const url = new URL(`${this.endpoint}${path.startsWith('/') ? '' : '/'}${path}`);

    if (Array.isArray(searchParams)) {
      for (const value of searchParams) {
        url.searchParams.append('queries[]', value);
      }
    } else if (searchParams instanceof URLSearchParams) {
      searchParams.forEach((value, key) => {
        url.searchParams.append(key, value);
      });
    }

    const headers = {
      'Content-Type': 'application/json',
      'X-Appwrite-Project': this.projectId,
      'X-Appwrite-Key': this.apiKey
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });

    const contentType = response.headers.get('content-type') || '';
    const isJson = contentType.includes('application/json');
    const raw = await response.text();
    const payload = raw && isJson ? JSON.parse(raw) : raw || null;

    if (!response.ok) {
      const message = payload?.message || `${method} ${url.pathname} failed (${response.status})`;
      if (![404, 409].includes(response.status)) {
        console.error(`[Appwrite] ${method} ${url.toString()} -> ${response.status} ${raw}`);
      }
      throw new AppwriteError(message, response.status, payload);
    }

    return payload;
  }

  async getCollection(databaseId, collectionId) {
    try {
      return await this.request({
        method: 'GET',
        path: `/databases/${databaseId}/collections/${collectionId}`
      });
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async listCollections(databaseId) {
    const collections = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const params = new URLSearchParams();
      params.set('limit', limit);
      params.set('offset', offset);

      const result = await this.request({
        method: 'GET',
        path: `/databases/${databaseId}/collections`,
        searchParams: params
      });

      collections.push(...(result.collections || []));
      if (!result.total || collections.length >= result.total) break;
      offset += limit;
    }

    return collections;
  }

  async createCollection(databaseId, collectionId, name) {
    return this.request({
      method: 'POST',
      path: `/databases/${databaseId}/collections`,
      body: {
        collectionId,
        name,
        permissions: [],
        documentSecurity: false,
        enabled: true
      }
    });
  }

  async ensureStringAttribute(databaseId, collectionId, { key, size = 255, required = false, array = false, defaultValue = null }) {
    try {
      await this.request({
        method: 'POST',
        path: `/databases/${databaseId}/collections/${collectionId}/attributes/string`,
        body: {
          key,
          size,
          required,
          default: defaultValue,
          array
        }
      });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }

  async ensureBooleanAttribute(databaseId, collectionId, { key, required = false, defaultValue = null, array = false }) {
    try {
      await this.request({
        method: 'POST',
        path: `/databases/${databaseId}/collections/${collectionId}/attributes/boolean`,
        body: {
          key,
          required,
          default: defaultValue,
          array
        }
      });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }

  async ensureIntegerAttribute(databaseId, collectionId, { key, required = false, defaultValue = null, array = false }) {
    try {
      await this.request({
        method: 'POST',
        path: `/databases/${databaseId}/collections/${collectionId}/attributes/integer`,
        body: {
          key,
          required,
          default: defaultValue,
          array
        }
      });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }

  async ensureFloatAttribute(databaseId, collectionId, { key, required = false, defaultValue = null, array = false }) {
    try {
      await this.request({
        method: 'POST',
        path: `/databases/${databaseId}/collections/${collectionId}/attributes/float`,
        body: {
          key,
          required,
          default: defaultValue,
          array
        }
      });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }

  async ensureDatetimeAttribute(databaseId, collectionId, { key, required = false, defaultValue = null, array = false }) {
    try {
      await this.request({
        method: 'POST',
        path: `/databases/${databaseId}/collections/${collectionId}/attributes/datetime`,
        body: {
          key,
          required,
          default: defaultValue,
          array
        }
      });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }

  async ensureIndex(databaseId, collectionId, { key, type = 'key', attributes = [], orders = [] }) {
    try {
      await this.request({
        method: 'POST',
        path: `/databases/${databaseId}/collections/${collectionId}/indexes`,
        body: {
          key,
          type,
          attributes,
          orders
        }
      });
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }

  async getDocument(databaseId, collectionId, documentId) {
    try {
      return await this.request({
        method: 'GET',
        path: `/databases/${databaseId}/collections/${collectionId}/documents/${documentId}`
      });
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async listDocuments(databaseId, collectionId, queries = []) {
    const documents = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const params = new URLSearchParams();
      params.set('limit', limit);
      params.set('offset', offset);
      for (const query of queries.filter(Boolean)) {
        params.append('queries[]', query);
      }

      const result = await this.request({
        method: 'GET',
        path: `/databases/${databaseId}/collections/${collectionId}/documents`,
        searchParams: params
      });
      documents.push(...(result.documents || []));
      if (!result.total || documents.length >= result.total) break;
      offset += limit;
    }

    return documents;
  }

  async createDocument(databaseId, collectionId, documentId, data) {
    return this.request({
      method: 'POST',
      path: `/databases/${databaseId}/collections/${collectionId}/documents`,
      body: {
        documentId,
        data
      }
    });
  }

  async updateDocument(databaseId, collectionId, documentId, data) {
    return this.request({
      method: 'PATCH',
      path: `/databases/${databaseId}/collections/${collectionId}/documents/${documentId}`,
      body: { data }
    });
  }

  async deleteDocument(databaseId, collectionId, documentId) {
    try {
      await this.request({
        method: 'DELETE',
        path: `/databases/${databaseId}/collections/${collectionId}/documents/${documentId}`
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  async deleteCollection(databaseId, collectionId) {
    try {
      await this.request({
        method: 'DELETE',
        path: `/databases/${databaseId}/collections/${collectionId}`
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
}

export class AppwriteSchemaInspector {
  constructor({ client, databaseId }) {
    this.client = client;
    this.databaseId = databaseId;
  }

  async describe() {
    const collections = await this.client.listCollections(this.databaseId);
    const map = new Map();

    for (const collection of collections) {
      map.set(collection.$id, {
        collection,
        attributes: collection.attributes || [],
        indexes: collection.indexes || []
      });
    }

    return map;
  }
}

export class AppwriteStateStore {
  constructor({ client, databaseId, stateCollectionId = 'awm_state', lockCollectionId = 'awm_locks' }) {
    this.client = client;
    this.databaseId = databaseId;
    this.stateCollectionId = stateCollectionId;
    this.lockCollectionId = lockCollectionId;
  }

  async init() {
    await this.ensureStateCollection();
    await this.ensureLockCollection();
  }

  async ensureStateCollection() {
    const exists = await this.client.getCollection(this.databaseId, this.stateCollectionId);
    if (!exists) {
      await this.client.createCollection(this.databaseId, this.stateCollectionId, 'AWM State');
    }

    await this.client.ensureStringAttribute(this.databaseId, this.stateCollectionId, {
      key: 'record_type',
      size: 64,
      required: true
    });

    await this.client.ensureStringAttribute(this.databaseId, this.stateCollectionId, {
      key: 'record_id',
      size: 128,
      required: true
    });

    await this.client.ensureStringAttribute(this.databaseId, this.stateCollectionId, {
      key: 'status',
      size: 50,
      required: false
    });

    await this.client.ensureStringAttribute(this.databaseId, this.stateCollectionId, {
      key: 'payload',
      size: 20000,
      required: false
    });

    await this.client.ensureDatetimeAttribute(this.databaseId, this.stateCollectionId, {
      key: 'created_at',
      required: true,
      defaultValue: null
    });

    await this.client.ensureDatetimeAttribute(this.databaseId, this.stateCollectionId, {
      key: 'updated_at',
      required: false
    });

    await this.client.ensureIndex(this.databaseId, this.stateCollectionId, {
      key: 'idx_record_type',
      type: 'key',
      attributes: ['record_type']
    });

    await this.client.ensureIndex(this.databaseId, this.stateCollectionId, {
      key: 'idx_record_type_id',
      type: 'unique',
      attributes: ['record_type', 'record_id'],
      orders: ['ASC', 'ASC']
    });
  }

  async ensureLockCollection() {
    const exists = await this.client.getCollection(this.databaseId, this.lockCollectionId);
    if (!exists) {
      await this.client.createCollection(this.databaseId, this.lockCollectionId, 'AWM Locks');
    }

    await this.client.ensureStringAttribute(this.databaseId, this.lockCollectionId, {
      key: 'lock_id',
      size: 64,
      required: true
    });

    await this.client.ensureStringAttribute(this.databaseId, this.lockCollectionId, {
      key: 'owner',
      size: 255,
      required: false
    });

    await this.client.ensureStringAttribute(this.databaseId, this.lockCollectionId, {
      key: 'status',
      size: 50,
      required: false
    });

    await this.client.ensureDatetimeAttribute(this.databaseId, this.lockCollectionId, {
      key: 'created_at',
      required: true
    });

    await this.client.ensureDatetimeAttribute(this.databaseId, this.lockCollectionId, {
      key: 'expires_at',
      required: false
    });

    await this.client.ensureStringAttribute(this.databaseId, this.lockCollectionId, {
      key: 'metadata',
      size: 2000,
      required: false
    });

    await this.client.ensureIndex(this.databaseId, this.lockCollectionId, {
      key: 'idx_lock_id',
      type: 'unique',
      attributes: ['lock_id']
    });
  }

  _docId(type, recordId) {
    return crypto.createHash('md5').update(`${type}:${recordId}`).digest('hex');
  }

  _serializePayload(payload) {
    if (payload === undefined || payload === null) return null;
    return JSON.stringify(payload);
  }

  _deserializePayload(payload) {
    if (!payload) return null;
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }

  async upsertRecord(type, recordId, payload, status) {
    const documentId = this._docId(type, recordId);
    const existing = await this.client.getDocument(this.databaseId, this.stateCollectionId, documentId);
    const now = new Date().toISOString();

    const data = {
      record_type: type,
      record_id: recordId,
      status: status || existing?.status || null,
      payload: this._serializePayload(payload),
      updated_at: now
    };

    if (existing) {
      await this.client.updateDocument(this.databaseId, this.stateCollectionId, documentId, data);
    } else {
      data.created_at = now;
      await this.client.createDocument(this.databaseId, this.stateCollectionId, documentId, data);
    }
  }

  async deleteRecord(type, recordId) {
    const documentId = this._docId(type, recordId);
    await this.client.deleteDocument(this.databaseId, this.stateCollectionId, documentId);
  }

  async listRecords(type) {
    const docs = await this.client.listDocuments(this.databaseId, this.stateCollectionId);
    return docs
      .filter(doc => doc.record_type === type)
      .map(doc => ({
      id: doc.record_id,
      status: doc.status || null,
      payload: this._deserializePayload(doc.payload),
      documentId: doc.$id,
      createdAt: doc.created_at || doc.$createdAt,
      updatedAt: doc.updated_at || doc.$updatedAt
      }));
  }

  async getRecord(type, recordId) {
    const documentId = this._docId(type, recordId);
    const doc = await this.client.getDocument(this.databaseId, this.stateCollectionId, documentId);
    if (!doc) return null;
    return {
      id: doc.record_id,
      status: doc.status || null,
      payload: this._deserializePayload(doc.payload),
      documentId: doc.$id,
      createdAt: doc.created_at || doc.$createdAt,
      updatedAt: doc.updated_at || doc.$updatedAt
    };
  }

  async countRecords(type) {
    const docs = await this.listRecords(type);
    return docs.length;
  }

  async reset() {
    const docs = await this.client.listDocuments(this.databaseId, this.stateCollectionId);
    for (const doc of docs) {
      await this.client.deleteDocument(this.databaseId, this.stateCollectionId, doc.$id);
    }
  }

  async recordHistory(payload, status = 'applied') {
    const recordId = crypto.randomUUID().replace(/-/g, '');
    const now = new Date().toISOString();
    const documentId = this._docId('history', recordId);

    await this.client.createDocument(this.databaseId, this.stateCollectionId, documentId, {
      record_type: 'history',
      record_id: recordId,
      status,
      payload: this._serializePayload(payload),
      created_at: now,
      updated_at: now
    });

    return recordId;
  }

  async updateHistoryStatus(recordId, status) {
    const documentId = this._docId('history', recordId);
    await this.client.updateDocument(this.databaseId, this.stateCollectionId, documentId, {
      status,
      updated_at: new Date().toISOString()
    });
  }

  async latestHistory(status = 'applied') {
    const docs = await this.client.listDocuments(this.databaseId, this.stateCollectionId, [
      'orderDesc("$createdAt")'
    ]);

    const doc = docs.find(item => item.record_type === 'history' && (!status || item.status === status));
    if (!doc) return null;
    return {
      recordId: doc.record_id,
      status: doc.status || null,
      payload: this._deserializePayload(doc.payload),
      documentId: doc.$id,
      createdAt: doc.$createdAt
    };
  }
}

export class AppwriteLockManager {
  constructor({ client, databaseId, collectionId = 'awm_locks' }) {
    this.client = client;
    this.databaseId = databaseId;
    this.collectionId = collectionId;
  }

  async init() {
    // Collection is ensured by state store; nothing to do here currently.
  }

  _docId(lockId) {
    return crypto.createHash('md5').update(`lock:${lockId}`).digest('hex');
  }

  async acquire(lockId, { owner = 'unknown', ttlSeconds = 600, force = false } = {}) {
    const documentId = this._docId(lockId);
    const now = new Date();
    const expiresAt = ttlSeconds ? new Date(now.getTime() + ttlSeconds * 1000) : null;

    try {
      await this.client.createDocument(this.databaseId, this.collectionId, documentId, {
        lock_id: lockId,
        owner,
        status: 'locked',
        created_at: now.toISOString(),
        expires_at: expiresAt ? expiresAt.toISOString() : null
      });
      return;
    } catch (error) {
      if (error.status !== 409) {
        throw error;
      }
    }

    const existing = await this.client.getDocument(this.databaseId, this.collectionId, documentId);
    if (!existing) {
      return this.acquire(lockId, { owner, ttlSeconds, force });
    }

    const expired = existing.expires_at && new Date(existing.expires_at) < new Date();
    const sameOwner = existing.owner === owner;

    if (!force && !expired && !sameOwner) {
      throw new Error(`Lock '${lockId}' is held by ${existing.owner || 'unknown'} since ${existing.created_at}`);
    }

    await this.client.updateDocument(this.databaseId, this.collectionId, documentId, {
      owner,
      status: 'locked',
      created_at: now.toISOString(),
      expires_at: expiresAt ? expiresAt.toISOString() : null
    });
  }

  async release(lockId, owner) {
    const documentId = this._docId(lockId);
    const existing = await this.client.getDocument(this.databaseId, this.collectionId, documentId);
    if (!existing) return;

    if (owner && existing.owner && existing.owner !== owner) {
      throw new Error(`Cannot release lock '${lockId}' held by ${existing.owner}`);
    }

    await this.client.deleteDocument(this.databaseId, this.collectionId, documentId);
  }
}
