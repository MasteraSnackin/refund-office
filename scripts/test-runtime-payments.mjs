import { fileURLToPath } from 'node:url';
import { runSupabaseRuntimeChecks } from './test-supabase-runtime.mjs';
import { runPaymentChecks } from '../tests/runtime-payments/checks.mjs';

runSupabaseRuntimeChecks({ additionalChecks: runPaymentChecks,
  outputDir: fileURLToPath(new URL('../work/runtime-payments', import.meta.url)),
}).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
