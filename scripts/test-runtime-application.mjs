import { fileURLToPath } from 'node:url';
import { runSupabaseRuntimeChecks } from './test-supabase-runtime.mjs';
import { runWorkflowChecks } from '../tests/runtime-workflow/checks.mjs';

runSupabaseRuntimeChecks({ additionalChecks: runWorkflowChecks,
  outputDir: fileURLToPath(new URL('../work/runtime-application', import.meta.url)),
}).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
