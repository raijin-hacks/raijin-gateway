import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Rules from Design.md and CHUNK-2-BUILD-PLAN.md that coding agents won't follow unprompted.
// ESLint replaces (does not merge) a rule's options per matching block, so each block
// below repeats every restriction that applies to its files.

const noEmptyCatch = {
  // Unlike the built-in no-empty, this also catches blocks that hold only a comment.
  selector: 'CatchClause > BlockStatement[body.length=0]',
  message: 'Empty catch blocks are banned: errors on the payment path must deny.',
};

const noSystemTime = [
  {
    selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
    message: 'Use deps.clock.now(); only clock.ts may read the system time.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Use deps.clock.now(); only clock.ts may read the system time.',
  },
];

const judgeOnlyImports = {
  paths: [
    { name: '@anthropic-ai/sdk', message: 'Only src/judge/ may call the model.' },
    {
      name: '@apf/contracts',
      importNames: ['JudgeInput'],
      message: 'Only buildInput in src/judge/ may construct JudgeInput.',
    },
  ],
};

// Pipeline steps that run before pre-contact passes must not reach the network.
const preNetworkFiles = [
  'apps/gateway/src/pipeline/idempotency.ts',
  'apps/gateway/src/pipeline/precontact.ts',
  'apps/gateway/src/pipeline/secrets.ts',
];

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '.venv/**', 'tests/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-restricted-syntax': ['error', noEmptyCatch],
    },
  },
  {
    files: ['apps/gateway/src/**/*.ts'],
    ignores: ['apps/gateway/src/clock.ts'],
    rules: {
      'no-restricted-syntax': ['error', noEmptyCatch, ...noSystemTime],
    },
  },
  {
    files: ['apps/gateway/src/**/*.ts'],
    ignores: ['apps/gateway/src/judge/**'],
    rules: {
      'no-restricted-imports': ['error', judgeOnlyImports],
    },
  },
  {
    files: preNetworkFiles,
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'No network call before pre-contact passes (invariant 4).' },
      ],
      'no-restricted-imports': [
        'error',
        {
          ...judgeOnlyImports,
          patterns: [
            {
              group: ['**/payments', '**/payments/**'],
              message: 'No payments code before pre-contact passes (invariant 4).',
            },
          ],
        },
      ],
    },
  },
];
