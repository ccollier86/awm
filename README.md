# AWM - Appwrite Migration Tool

A powerful schema management and code generation tool for Appwrite databases. AWM helps you manage your Appwrite collections, apply migrations, and generate TypeScript types and Zod schemas automatically.

## Features

- 📋 **Schema Management** - Define your database schema in a simple DSL
- 🔄 **Two-Phase Migrations** - Apply collections first, then relationships
- 📊 **Migration Tracking** - SQLite-based state tracking with rollback support
- 🎯 **TypeScript Generation** - Auto-generate types from your schema
- ✅ **Zod Schema Generation** - Runtime validation with Zod schemas
- 🔧 **Environment Configuration** - Flexible config via env vars or config files
- 🏠 **Self-Hosted First** - Defaults optimized for self-hosted Appwrite

## Installation

### Global Installation
```bash
npm install -g awm-appwrite
```

### Local Installation
```bash
npm install --save-dev awm-appwrite
```

### Direct Usage (without installation)
```bash
npx awm-appwrite <command>
```

## Quick Start

1. **Initialize AWM in your project:**
```bash
awm init
```

2. **Create your schema file (`appwrite.schema`):**
```javascript
database {
  name = "my-database"
  id   = "my-database-id"
}

collection users {
  name        String   @size(255) @required
  email       String   @size(255) @required @unique
  created_at  DateTime @default(now)
  
  @@index([email])
}

collection posts {
  title       String   @size(255) @required
  content     String   @size(5000) @required
  author_id   String   @required
  
  // Relationship (Phase 2)
  author      String   @relationship(to: "users", type: "many-to-one", twoWayKey: "posts", onDelete: "cascade")
  
  created_at  DateTime @default(now)
  
  @@index([author_id])
}
```

3. **Configure your environment (`.env`):**
```bash
# Required
APPWRITE_PROJECT_ID=your-project-id
APPWRITE_ENDPOINT=http://localhost/v1  # For self-hosted
APPWRITE_API_KEY=your-api-key          # Optional for client SDK

# Optional - Override defaults
APPWRITE_DATABASE_ID=my-database
AWM_SCHEMA=appwrite.schema
AWM_MIGRATIONS_DIR=migrations
AWM_STATE_DB=.awm-state.db
AWM_DEBUG=false
```

4. **Apply your schema:**
```bash
# Phase 1: Create collections and attributes
awm apply

# Phase 2: Create relationships
awm relationships
```

5. **Generate TypeScript types and Zod schemas:**
```bash
# Generate both
awm generate

# Or individually
awm generate-types types/appwrite.types.ts
awm generate-zod schemas/appwrite.schemas.ts
```

## Commands

| Command | Description |
|---------|-------------|
| `awm init` | Initialize AWM in your project |
| `awm plan` | Preview changes before applying |
| `awm apply` | Apply schema (collections & attributes) |
| `awm relationships` | Apply relationship attributes (Phase 2) |
| `awm status` | Show current migration status |
| `awm sync` | Sync state with Appwrite |
| `awm reset` | Reset migration tracking |
| `awm rollback <version>` | Rollback to a specific version |
| `awm generate-types [path]` | Generate TypeScript types |
| `awm generate-zod [path]` | Generate Zod schemas |
| `awm generate` | Generate both types and schemas |
| `awm help` | Show help message |

## Schema Syntax

### Collections
```javascript
collection collection_name {
  // Attributes
  field_name  Type  @decorators
}
```

### Attribute Types
- `String` - Text data
- `Int` - Integer numbers
- `Float` - Decimal numbers
- `Boolean` - True/false values
- `DateTime` - Date and time
- `String[]` - Array of strings (use with `@array`)

### Decorators
- `@required` - Field is required
- `@unique` - Field must be unique
- `@size(n)` - Maximum size/length
- `@array` - Field is an array
- `@default(value)` - Default value
- `@relationship(...)` - Define relationships (Phase 2)

### Indexes
```javascript
@@index([field1, field2])  // Composite index
@@unique([field1, field2]) // Unique constraint
```

### Relationships (Phase 2)
```javascript
// One-to-many
posts Post[] @relationship(to: "posts", type: "one-to-many", twoWayKey: "author")

// Many-to-one
author User @relationship(to: "users", type: "many-to-one", twoWayKey: "posts", onDelete: "cascade")

// Many-to-many (use arrays)
tags String[] @array  // Store tag IDs as array
```

## Generated Code Examples

### TypeScript Types
```typescript
export interface User {
  $id?: string;
  $createdAt?: string;
  $updatedAt?: string;
  name: string;
  email: string;
  created_at?: Date | string;
}

export const Collections = {
  USERS: 'users',
  POSTS: 'posts'
} as const;
```

### Zod Schemas
```typescript
import { z } from 'zod';

export const UserSchema = z.object({
  $id: z.string().optional(),
  name: z.string().max(255),
  email: z.string().max(255),
  created_at: z.date().optional()
});

export type User = z.infer<typeof UserSchema>;

// Input schema (for creating records)
export const UserSchemaInput = UserSchema.omit({
  $id: true,
  $createdAt: true,
  $updatedAt: true
});
```

## Configuration Priority

AWM checks for configuration in this order:
1. Environment variables (`.env` file)
2. Config file (`.awm.json`, `awm.config.json`, etc.)
3. Default values

## Migration Strategy

AWM uses a two-phase migration approach:

**Phase 1: Collections & Attributes**
- Creates collections
- Adds regular attributes
- Sets up indexes
- Configures arrays

**Phase 2: Relationships**
- Adds relationship attributes
- Requires all collections to exist first
- Creates two-way connections

## State Management

AWM tracks migrations in a SQLite database (`.awm-state.db`):
- Records all applied migrations
- Tracks schema versions
- Enables rollback functionality
- Prevents duplicate operations

## Best Practices

1. **Always use Phase 1 before Phase 2** - Collections must exist before relationships
2. **Test with `plan` first** - Preview changes before applying
3. **Use arrays for many-to-many** - More flexible than relationship attributes
4. **Version control your schema** - Track schema changes in git
5. **Generate types after changes** - Keep TypeScript in sync
6. **Use environment variables** - Don't hardcode credentials

## Troubleshooting

### Migration Fails
```bash
# Check status
awm status

# Reset if needed
awm reset

# Try again
awm apply
```

### Relationship Errors
```bash
# Ensure Phase 1 is complete
awm apply

# Then apply relationships
awm relationships
```

### Type Generation Issues
```bash
# Ensure schema file exists
ls appwrite.schema

# Check syntax
awm plan

# Generate with explicit path
awm generate-types ./types/custom.types.ts
```

## Advanced Usage

### Custom Config File
```json
{
  "projectId": "my-project",
  "endpoint": "http://localhost/v1",
  "databaseId": "production",
  "schemaFile": "schema/appwrite.schema"
}
```

### Multiple Environments
```bash
# Development
AWM_SCHEMA=schema.dev awm apply

# Production
AWM_SCHEMA=schema.prod awm apply
```

### CI/CD Integration
```yaml
# GitHub Actions example
- name: Apply Appwrite Schema
  run: |
    npm install -g awm-appwrite
    awm apply
    awm relationships
    awm generate
  env:
    APPWRITE_PROJECT_ID: ${{ secrets.APPWRITE_PROJECT_ID }}
    APPWRITE_API_KEY: ${{ secrets.APPWRITE_API_KEY }}
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

## Support

For issues and questions, please use the GitHub issue tracker.