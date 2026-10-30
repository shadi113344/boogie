import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const testsDir = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(resolve(testsDir, '../.github/workflows/deploy.yml'), 'utf8');

describe('deploy workflow', () => {
  it('triggers on pushes to main and on manual dispatch', () => {
    expect(workflow).toMatch(/^on:\s*$/m);
    expect(workflow).toMatch(/^\s+push:\s*$/m);
    expect(workflow).toMatch(/^\s+branches:\s*$/m);
    expect(workflow).toMatch(/^\s+-\s+main\s*$/m);
    expect(workflow).toMatch(/^\s+workflow_dispatch:\s*$/m);
  });

  it('builds on ubuntu-latest', () => {
    expect(workflow).toMatch(/^  build:\s*$/m);
    expect(workflow).toMatch(/runs-on:\s*ubuntu-latest/);
  });

  it('checks out, installs node 24 with an npm cache and installs dependencies', () => {
    expect(workflow).toMatch(/uses:\s*actions\/checkout@v4/);
    expect(workflow).toMatch(/uses:\s*actions\/setup-node@v4/);
    expect(workflow).toMatch(/node-version:\s*24/);
    expect(workflow).toMatch(/cache:\s*npm/);
    expect(workflow).toMatch(/run:\s*npm ci/);
  });

  it('typechecks and tests before building', () => {
    expect(workflow).toMatch(/run:\s*npm run typecheck/);
    expect(workflow).toMatch(/run:\s*npm test/);
    expect(workflow).toMatch(/run:\s*npm run build/);
  });

  it('builds with the GitHub Pages base path', () => {
    expect(workflow).toMatch(/run:\s*npm run build\s*\n\s*env:\s*\n\s*BASE_PATH:\s*['"]?\/boogie\/['"]?/);
  });

  it('uploads dist as the pages artifact', () => {
    expect(workflow).toMatch(/uses:\s*actions\/upload-pages-artifact@v3/);
    expect(workflow).toMatch(/path:\s*dist/);
  });

  it('deploys the artifact after the build', () => {
    expect(workflow).toMatch(/^  deploy:\s*$/m);
    expect(workflow).toMatch(/needs:\s*build/);
    expect(workflow).toMatch(/pages:\s*write/);
    expect(workflow).toMatch(/id-token:\s*write/);
    expect(workflow).toMatch(/environment:\s*github-pages/);
    expect(workflow).toMatch(/uses:\s*actions\/deploy-pages@v4/);
  });
});
