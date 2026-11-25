'use strict';

module.exports = [
  { ignores: ['**/node_modules/**', 'test-data/**', 'dist/**', 'release/**', 'run-data/**', 'vendor/**'] },
  {
    files: ['src/**/*.{js,cjs}', 'scripts/**/*.{js,cjs}', 'test/**/*.cjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs' },
    rules: {
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-func-assign': 'error',
      'no-unreachable': 'error',
      'no-unexpected-multiline': 'error',
      'valid-typeof': 'error',
    },
  },
];
