#!/usr/bin/env node

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

export async function initProject() {
  console.log(`\n${colors.cyan}🚀 Initializing AWM in your project...${colors.reset}\n`);
  
  const files = {
    '.env.example': await fs.readFile(path.join(__dirname, '.env.example'), 'utf-8'),
    'appwrite.schema': await fs.readFile(path.join(__dirname, 'appwrite.schema.example'), 'utf-8'),
    '.awm.json': JSON.stringify({
      projectId: "your-project-id",
      endpoint: "http://localhost/v1",
      databaseId: "your-database",
      schemaFile: "appwrite.schema"
    }, null, 2)
  };
  
  const created = [];
  const skipped = [];
  
  for (const [filename, content] of Object.entries(files)) {
    const targetPath = path.join(process.cwd(), filename);
    
    try {
      // Check if file exists
      await fs.access(targetPath);
      skipped.push(filename);
    } catch {
      // File doesn't exist, create it
      await fs.writeFile(targetPath, content);
      created.push(filename);
    }
  }
  
  // Add .awm-state.db to .gitignore
  try {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    let gitignore = '';
    
    try {
      gitignore = await fs.readFile(gitignorePath, 'utf-8');
    } catch {
      // .gitignore doesn't exist
    }
    
    if (!gitignore.includes('.awm-state.db')) {
      gitignore += '\n# AWM state database\n.awm-state.db\n.awm-state.db-journal\n';
      await fs.writeFile(gitignorePath, gitignore);
      created.push('.gitignore (updated)');
    }
  } catch (error) {
    console.warn(`${colors.yellow}Warning: Could not update .gitignore${colors.reset}`);
  }
  
  // Print results
  if (created.length > 0) {
    console.log(`${colors.green}✅ Created files:${colors.reset}`);
    created.forEach(file => console.log(`   - ${file}`));
  }
  
  if (skipped.length > 0) {
    console.log(`\n${colors.yellow}⏭️  Skipped existing files:${colors.reset}`);
    skipped.forEach(file => console.log(`   - ${file}`));
  }
  
  console.log(`
${colors.bright}Next steps:${colors.reset}
1. Edit ${colors.cyan}.env.example${colors.reset} with your Appwrite credentials
2. Rename it to ${colors.cyan}.env${colors.reset}
3. Customize ${colors.cyan}appwrite.schema${colors.reset} for your project
4. Run ${colors.cyan}awm apply${colors.reset} to create collections
5. Run ${colors.cyan}awm relationships${colors.reset} to add relationships
6. Run ${colors.cyan}awm generate${colors.reset} to create TypeScript types

${colors.dim}For more information, see the README or run 'awm help'${colors.reset}
`);
}

// Export for use as module
export default initProject;