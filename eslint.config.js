// Config ESLint (flat config, ESLint 9). Lancer : npm run lint
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'builds/**',
      'assets/**',
      'data/**',
      'chunks/**',
      'css/**',
      // Fragment injecté dans quests.js (pas un module autonome)
      'scripts/build_quest_v2_snippet.js',
    ],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-dupe-keys': 'error',
      'no-const-assign': 'error',
      'no-redeclare': 'error',
      'no-self-assign': 'error',
      'no-dupe-else-if': 'error',
      'no-unsafe-finally': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['docs/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser, Chart: 'readonly' },
    },
  },
];
